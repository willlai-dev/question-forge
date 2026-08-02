import { describe, expect, it } from 'vitest';

import {
  REPRESENTATIVE_MAX_PER_TAG,
  REPRESENTATIVE_QUESTION_LIMIT,
  selectRepresentativeQuestions,
  type RepresentativeCandidate,
  type TagWeight,
} from './representative';

const candidate = (
  questionId: string,
  overrides: Partial<RepresentativeCandidate> = {},
): RepresentativeCandidate => ({
  questionId,
  wrongCount: 1,
  attemptCount: 1,
  masteryState: 'active',
  knowledgeTagIds: ['t1'],
  primaryKnowledgeTagId: 't1',
  errorTypeCodes: [],
  lastMissedAt: '2026-07-01T00:00:00.000Z',
  questionNumber: 1,
  ...overrides,
});

const tag = (tagId: string, accuracy: number | null, answered = 10): TagWeight => ({
  tagId,
  accuracy,
  answered,
});

describe('selectRepresentativeQuestions', () => {
  it('同樣的輸入跑兩次得到完全相同的結果', () => {
    const input = {
      candidates: [candidate('q1'), candidate('q2'), candidate('q3')],
      tagStats: [tag('t1', 40)],
    };
    expect(selectRepresentativeQuestions(input)).toEqual(selectRepresentativeQuestions(input));
  });

  it('**打亂輸入順序後結果完全相同**（排序若非全序必然失敗）', () => {
    const candidates = [
      candidate('q-c', { wrongCount: 2, questionNumber: 3 }),
      candidate('q-a', { wrongCount: 2, questionNumber: 3 }),
      candidate('q-b', { wrongCount: 2, questionNumber: 3 }),
      candidate('q-d', { wrongCount: 2, questionNumber: 3 }),
    ];
    const tagStats = [tag('t1', 50)];

    const forward = selectRepresentativeQuestions({ candidates, tagStats });
    const reversed = selectRepresentativeQuestions({
      candidates: [...candidates].reverse(),
      tagStats,
    });
    const rotated = selectRepresentativeQuestions({
      candidates: [candidates[2], candidates[0], candidates[3], candidates[1]],
      tagStats,
    });

    expect(reversed.questionIds).toEqual(forward.questionIds);
    expect(rotated.questionIds).toEqual(forward.questionIds);
  });

  it('其他條件全同時，questionId 字典序小的排前面', () => {
    const a = candidate('aaa', { primaryKnowledgeTagId: null, knowledgeTagIds: [] });
    const b = candidate('bbb', { primaryKnowledgeTagId: null, knowledgeTagIds: [] });

    expect(
      selectRepresentativeQuestions({ candidates: [b, a], tagStats: [] }).questionIds,
    ).toEqual(['aaa', 'bbb']);
    expect(
      selectRepresentativeQuestions({ candidates: [a, b], tagStats: [] }).questionIds,
    ).toEqual(['aaa', 'bbb']);
  });

  it('不超過上限', () => {
    const candidates = Array.from({ length: 40 }, (_, i) =>
      candidate(`q${String(i).padStart(2, '0')}`, {
        primaryKnowledgeTagId: `t${i}`,
        knowledgeTagIds: [`t${i}`],
      }),
    );
    const result = selectRepresentativeQuestions({ candidates, tagStats: [] });
    expect(result.questionIds).toHaveLength(REPRESENTATIVE_QUESTION_LIMIT);
    expect(result.scored).toHaveLength(REPRESENTATIVE_QUESTION_LIMIT);
  });

  it('候選少於上限時全部回傳', () => {
    const candidates = [candidate('q1'), candidate('q2')];
    expect(
      selectRepresentativeQuestions({ candidates, tagStats: [] }).questionIds,
    ).toHaveLength(2);
  });

  it('同一主要知識點的配額被遵守，且溢位者回填到滿', () => {
    // 8 題全掛同一個主要知識點，配額 3，但 limit 5 → 先取 3，再回填 2
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate(`q${i}`, { questionNumber: i }),
    );
    const result = selectRepresentativeQuestions({
      candidates,
      tagStats: [tag('t1', 30)],
      limit: 5,
    });
    expect(result.questionIds).toHaveLength(5);
    // 前 3 個是配額內的，順序仍照排序
    expect(result.questionIds.slice(0, 3)).toEqual(['q0', 'q1', 'q2']);
  });

  it('配額擋不住沒有主要知識點的題目', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidate(`q${i}`, { primaryKnowledgeTagId: null, knowledgeTagIds: [], questionNumber: i }),
    );
    const result = selectRepresentativeQuestions({ candidates, tagStats: [], limit: 6 });
    expect(result.questionIds).toHaveLength(6);
  });

  it('答錯次數相同時，仍是 active 的排在已改善的前面', () => {
    const active = candidate('q-active', { masteryState: 'active', questionNumber: 2 });
    const mastered = candidate('q-mastered', { masteryState: 'mastered', questionNumber: 1 });
    const result = selectRepresentativeQuestions({
      candidates: [mastered, active],
      tagStats: [tag('t1', 50)],
    });
    expect(result.questionIds[0]).toBe('q-active');
  });

  it('屬於低正確率知識點的題目排在高正確率的前面', () => {
    const weak = candidate('q-weak', {
      knowledgeTagIds: ['weak'],
      primaryKnowledgeTagId: 'weak',
      questionNumber: 2,
    });
    const strong = candidate('q-strong', {
      knowledgeTagIds: ['strong'],
      primaryKnowledgeTagId: 'strong',
      questionNumber: 1,
    });
    const result = selectRepresentativeQuestions({
      candidates: [strong, weak],
      tagStats: [tag('weak', 20), tag('strong', 90)],
    });
    expect(result.questionIds[0]).toBe('q-weak');
  });

  it('accuracy 為 null 的知識點貢獻 0，且不會產生 NaN', () => {
    const result = selectRepresentativeQuestions({
      candidates: [candidate('q1'), candidate('q2', { questionNumber: 2 })],
      tagStats: [tag('t1', null)],
    });
    for (const entry of result.scored) {
      expect(Number.isFinite(entry.score)).toBe(true);
    }
    // 沒有知識點權重時，分數只剩答錯次數與 active 加成
    expect(result.scored[0].score).toBe(100 + 60);
  });

  it('沒有標籤統計時也不會壞', () => {
    const result = selectRepresentativeQuestions({
      candidates: [candidate('q1')],
      tagStats: [],
    });
    expect(Number.isFinite(result.scored[0].score)).toBe(true);
  });

  it('答錯次數的加分有上限，超過就不再拉開差距', () => {
    const many = candidate('q-many', { wrongCount: 9, primaryKnowledgeTagId: null, knowledgeTagIds: [] });
    const capped = candidate('q-cap', { wrongCount: 5, primaryKnowledgeTagId: null, knowledgeTagIds: [] });
    const result = selectRepresentativeQuestions({
      candidates: [many, capped],
      tagStats: [],
    });
    const scores = new Map(result.scored.map((s) => [s.questionId, s.score]));
    expect(scores.get('q-many')).toBe(scores.get('q-cap'));
  });

  it('空候選回空結果，不丟例外', () => {
    expect(selectRepresentativeQuestions({ candidates: [], tagStats: [] })).toEqual({
      questionIds: [],
      scored: [],
    });
  });

  it('計分理由是穩定的字串，會寫進 snapshot 給人看', () => {
    const result = selectRepresentativeQuestions({
      candidates: [candidate('q1', { wrongCount: 3, errorTypeCodes: ['CALC'] })],
      tagStats: [tag('t1', 25)],
    });
    expect(result.scored[0].reasons).toEqual([
      '答錯 3 次',
      '尚未開始改善',
      '所屬知識點正確率 25%',
      '已標記錯誤類型',
    ]);
  });

  it('預設配額常數符合規格（最多 15 題、單一知識點最多 3 題）', () => {
    expect(REPRESENTATIVE_QUESTION_LIMIT).toBe(15);
    expect(REPRESENTATIVE_MAX_PER_TAG).toBe(3);
  });
});
