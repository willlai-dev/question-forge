'use client';

import type { QuestionResponse, QuestionType } from '@repo/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Card, ErrorBanner, Field, Input, selectClass, textareaClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface OptionDraft {
  key: string;
  text: string;
  isCorrect: boolean;
}

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const emptyOptions = (): OptionDraft[] => [
  { key: 'A', text: '', isCorrect: false },
  { key: 'B', text: '', isCorrect: false },
  { key: 'C', text: '', isCorrect: false },
  { key: 'D', text: '', isCorrect: false },
];

/** 題目新增與編輯共用的表單。單選／複選的答案規則在送出前先於前端提示。 */
export function QuestionForm({ existing }: { existing?: QuestionResponse }) {
  const router = useRouter();
  const isEdit = Boolean(existing);

  const [groupId, setGroupId] = useState(existing?.questionGroupId ?? '');
  const [type, setType] = useState<QuestionType>(existing?.type ?? 'single_choice');
  const [questionNumber, setQuestionNumber] = useState(String(existing?.questionNumber ?? 1));
  const [stem, setStem] = useState(existing?.stem ?? '');
  const [explanation, setExplanation] = useState(existing?.explanation ?? '');
  const [sourcePage, setSourcePage] = useState(String(existing?.sourcePage ?? ''));
  const [reviewRequired, setReviewRequired] = useState(existing?.reviewRequired ?? false);
  const [options, setOptions] = useState<OptionDraft[]>(
    existing?.options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })) ??
      emptyOptions(),
  );

  const groups = useQuery({
    queryKey: ['question-groups', 'all'],
    queryFn: () =>
      api.get<{ items: { id: string; name: string; subjectName: string }[] }>(
        '/question-groups?pageSize=100',
      ),
  });

  const correctCount = options.filter((o) => o.isCorrect).length;
  const localError =
    type === 'single_choice' && correctCount !== 1
      ? `單選題必須恰好一個正確答案，目前有 ${correctCount} 個`
      : type === 'multiple_choice' && correctCount < 2
        ? `複選題至少需要兩個正確答案，目前有 ${correctCount} 個`
        : options.filter((o) => o.text.trim()).length < 2
          ? '至少需要兩個有內容的選項'
          : null;

  const payload = () => ({
    questionNumber: Number(questionNumber),
    type,
    stem: stem.trim(),
    options: options
      .filter((o) => o.text.trim())
      .map((o) => ({ key: o.key, text: o.text.trim(), isCorrect: o.isCorrect })),
    // 空白視為沒有解析。系統不會自動產生內容。
    explanation: explanation.trim() || null,
    sourcePage: sourcePage ? Number(sourcePage) : null,
    reviewRequired,
  });

  const mutation = useMutation({
    mutationFn: () =>
      isEdit
        ? api.patch<QuestionResponse>(`/questions/${existing!.id}`, payload())
        : api.post<QuestionResponse>('/questions', { questionGroupId: groupId, ...payload() }),
    onSuccess: () => router.push('/questions'),
  });

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;
  const canSubmit = Boolean((isEdit || groupId) && stem.trim() && !localError);

  const setOption = (index: number, patch: Partial<OptionDraft>) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));

  const toggleCorrect = (index: number) =>
    setOptions((prev) =>
      prev.map((o, i) =>
        i === index
          ? { ...o, isCorrect: !o.isCorrect }
          : // 單選題：勾選一個就取消其他，避免使用者要自己清掉
            type === 'single_choice'
            ? { ...o, isCorrect: false }
            : o,
      ),
    );

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) mutation.mutate();
      }}
    >
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {!isEdit && (
            <Field label="題組（必填）">
              <select
                className={selectClass}
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">請選擇題組</option>
                {groups.data?.items.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.subjectName} / {g.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="題型">
            <select
              className={selectClass}
              value={type}
              onChange={(e) => setType(e.target.value as QuestionType)}
            >
              <option value="single_choice">單選題</option>
              <option value="multiple_choice">複選題</option>
            </select>
          </Field>

          <Field label="題號">
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={questionNumber}
              onChange={(e) => setQuestionNumber(e.target.value)}
            />
          </Field>
        </div>

        <Field label="題幹">
          <textarea
            className={cn(textareaClass, 'min-h-24')}
            value={stem}
            onChange={(e) => setStem(e.target.value)}
            placeholder="輸入完整題幹"
          />
        </Field>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="font-medium">選項與答案</h2>
          <span className="text-xs text-muted-foreground">
            {type === 'single_choice' ? '單選：勾選一個正確答案' : '複選：勾選至少兩個正確答案'}
          </span>
        </div>

        {options.map((option, index) => (
          <div key={option.key} className="flex items-center gap-2 sm:gap-3">
            <span className="w-4 shrink-0 text-sm font-medium sm:w-6">{option.key}</span>
            {/*
              Input 本身是 w-full，在 flex 容器裡需要一層 min-w-0 才收得下去；
              少了它，選項文字一長就會把右邊的「正確」核取方塊推出卡片外。
            */}
            <div className="min-w-0 flex-1">
              <Input
                value={option.text}
                onChange={(e) => setOption(index, { text: e.target.value })}
                placeholder={`選項 ${option.key} 的內容`}
              />
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5 sm:h-4 sm:w-4"
                checked={option.isCorrect}
                onChange={() => toggleCorrect(index)}
              />
              正確
            </label>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={options.length >= KEYS.length}
            onClick={() =>
              setOptions((prev) => [
                ...prev,
                { key: KEYS[prev.length]!, text: '', isCorrect: false },
              ])
            }
          >
            新增選項
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={options.length <= 2}
            onClick={() => setOptions((prev) => prev.slice(0, -1))}
          >
            移除最後一個
          </Button>
        </div>

        {localError && <p className="text-sm text-destructive">{localError}</p>}
      </Card>

      <Card className="space-y-4">
        <Field
          label="解析（選填）"
          hint="留空代表沒有解析。系統不會自動產生內容。"
        >
          <textarea
            className={cn(textareaClass, 'min-h-20')}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="來源頁碼（選填）">
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={sourcePage}
              onChange={(e) => setSourcePage(e.target.value)}
            />
          </Field>
          {/*
            `items-end pb-2` 是為了在桌機和左邊的欄位底線對齊。
            手機單欄時上面沒有東西可對齊，那個 pb-2 只會變成莫名的空白。
          */}
          <label className="flex min-h-10 items-center gap-2 text-sm sm:min-h-0 sm:items-end sm:pb-2">
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0 sm:h-4 sm:w-4"
              checked={reviewRequired}
              onChange={(e) => setReviewRequired(e.target.checked)}
            />
            標記為需人工複核
          </label>
        </div>
      </Card>

      {serverError && <ErrorBanner message={serverError.message} details={serverError.details} />}

      <div className="flex gap-3">
        <Button type="submit" className="flex-1 sm:flex-none" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? '儲存中…' : isEdit ? '儲存變更' : '建立題目'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex-1 sm:flex-none"
          onClick={() => router.back()}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
