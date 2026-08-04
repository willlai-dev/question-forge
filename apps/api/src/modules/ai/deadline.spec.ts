import { describe, expect, it } from 'vitest';

import { withDeadline } from './ai-queue.service';

/** 永遠不會 settle 的 promise，用來模擬「那次呼叫掛住了」。 */
const neverSettles = (): Promise<string> => new Promise<string>(() => undefined);

/**
 * 任務總時限。
 *
 * 這個機制是為了避免「任務永遠停在 active」——實際遇過一次分析卡在
 * SYNTHESIZING_EVIDENCE 超過 10 分鐘、用量紀錄一片空白、沒有任何錯誤。
 * 使用者只能盯著一個不會動的進度條。
 */
describe('withDeadline', () => {
  it('在時限內完成就正常回傳結果', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('超過時限會拒絕，而不是無限等待', async () => {
    const never = neverSettles();
    await expect(withDeadline(never, 20)).rejects.toThrow(/超過/);
  });

  it('錯誤訊息帶得出秒數與可行動的下一步', async () => {
    // 用 1 秒而不是更長：這個測試會真的等滿，沒必要為了驗訊息格式多等幾秒。
    const never = neverSettles();
    await expect(withDeadline(never, 1000)).rejects.toThrow(/1 秒[\s\S]*重跑/);
  });

  it('原本的錯誤會照原樣往外拋，不會被時限訊息蓋掉', async () => {
    const boom = Promise.reject(new Error('模型回了不合法的結構'));
    await expect(withDeadline(boom, 1000)).rejects.toThrow('模型回了不合法的結構');
  });

  it('提早完成時不會留下未清除的計時器而卡住行程', async () => {
    // 若 finally 沒有 clearTimeout，vitest 會因為有未結束的 handle 而拖到逾時。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => withDeadline(Promise.resolve(1), 60_000)),
    );
    expect(results).toEqual([1, 1, 1, 1, 1]);
  });
});
