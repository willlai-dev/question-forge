import { describe, expect, it } from 'vitest';

import { bootstrapRequestSchema } from './auth';
import { reorderRequestSchema } from './common';
import { createQuestionGroupSchema, createSubjectSchema } from './question-bank';

const validBootstrap = {
  username: 'owner',
  password: 'a-very-long-password',
  confirmPassword: 'a-very-long-password',
};

describe('bootstrapRequestSchema', () => {
  it('接受合法輸入', () => {
    expect(bootstrapRequestSchema.safeParse(validBootstrap).success).toBe(true);
  });

  it('密碼少於 12 字元 → 失敗', () => {
    const r = bootstrapRequestSchema.safeParse({
      ...validBootstrap,
      password: 'short',
      confirmPassword: 'short',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('password'))).toBe(true);
  });

  it('兩次密碼不一致 → 失敗且指向 confirmPassword', () => {
    const r = bootstrapRequestSchema.safeParse({
      ...validBootstrap,
      confirmPassword: 'different-password-1',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });

  it('密碼與帳號相同 → 失敗', () => {
    const r = bootstrapRequestSchema.safeParse({
      username: 'averylongusername',
      password: 'averylongusername',
      confirmPassword: 'averylongusername',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.message.includes('不得與帳號相同'))).toBe(true);
  });

  it('帳號含非法字元 → 失敗', () => {
    expect(
      bootstrapRequestSchema.safeParse({ ...validBootstrap, username: '使用者 名稱' }).success,
    ).toBe(false);
  });

  it('多餘欄位 → 失敗（strict）', () => {
    expect(
      bootstrapRequestSchema.safeParse({ ...validBootstrap, isAdmin: true }).success,
    ).toBe(false);
  });
});

describe('reorderRequestSchema', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';

  it('接受不重複的 UUID 清單', () => {
    expect(reorderRequestSchema.safeParse({ orderedIds: [a, b] }).success).toBe(true);
  });

  it('重複 ID → 失敗', () => {
    const r = reorderRequestSchema.safeParse({ orderedIds: [a, a] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('重複');
  });

  it('空陣列 → 失敗', () => {
    expect(reorderRequestSchema.safeParse({ orderedIds: [] }).success).toBe(false);
  });

  it('非 UUID → 失敗', () => {
    expect(reorderRequestSchema.safeParse({ orderedIds: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('createSubjectSchema', () => {
  it('去除前後空白', () => {
    const r = createSubjectSchema.parse({ name: '  行政法  ' });
    expect(r.name).toBe('行政法');
  });

  it('全為空白的名稱 → 失敗', () => {
    expect(createSubjectSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('createQuestionGroupSchema', () => {
  const subjectId = '11111111-1111-4111-8111-111111111111';

  it('chapterId 可為 null（題組直接隸屬科目）', () => {
    const r = createQuestionGroupSchema.safeParse({ subjectId, chapterId: null, name: '題組' });
    expect(r.success).toBe(true);
  });

  it('chapterId 可省略', () => {
    expect(createQuestionGroupSchema.safeParse({ subjectId, name: '題組' }).success).toBe(true);
  });

  it('年份超出範圍 → 失敗', () => {
    expect(
      createQuestionGroupSchema.safeParse({ subjectId, name: '題組', year: 1800 }).success,
    ).toBe(false);
  });
});
