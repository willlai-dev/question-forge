'use client';

import type {
  KnowledgeTagResponse,
  PaginationMeta,
  QuestionTagResponse,
  SkillTagResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button, Card, ErrorBanner, Field } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface QuestionTags {
  knowledgeTags: QuestionTagResponse[];
  skillTags: QuestionTagResponse[];
}

/**
 * 題目的標籤編輯。
 *
 * 刻意與題目本身分開儲存：標籤走 `PUT /questions/:id/tags`，
 * 不會遞增題目版本，也不影響 content_hash。
 * 若併進題目表單一起送，改一個標籤就會多一筆版本快照，讓「這題被改過幾次」失去意義。
 */
export function QuestionTagsEditor({ questionId }: { questionId: string }) {
  const qc = useQueryClient();
  const [primaryKnowledge, setPrimaryKnowledge] = useState('');
  const [secondaryKnowledge, setSecondaryKnowledge] = useState<string[]>([]);
  const [primarySkill, setPrimarySkill] = useState('');
  const [saved, setSaved] = useState(false);

  const current = useQuery({
    queryKey: ['questions', questionId, 'tags'],
    queryFn: () => api.get<QuestionTags>(`/questions/${questionId}/tags`),
  });

  const knowledgeTags = useQuery({
    queryKey: ['knowledge-tags', 'all'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100&status=active',
      ),
  });

  const skillTags = useQuery({
    queryKey: ['skill-tags'],
    queryFn: () => api.get<SkillTagResponse[]>('/skill-tags'),
  });

  useEffect(() => {
    if (!current.data) return;
    setPrimaryKnowledge(current.data.knowledgeTags.find((t) => t.role === 'primary')?.id ?? '');
    setSecondaryKnowledge(
      current.data.knowledgeTags.filter((t) => t.role === 'secondary').map((t) => t.id),
    );
    setPrimarySkill(current.data.skillTags.find((t) => t.role === 'primary')?.id ?? '');
  }, [current.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put<QuestionTags>(`/questions/${questionId}/tags`, {
        primaryKnowledgeTagId: primaryKnowledge || null,
        secondaryKnowledgeTagIds: secondaryKnowledge.filter(Boolean),
        primarySkillTagId: primarySkill || null,
        secondarySkillTagIds: [],
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['questions'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const error = save.error instanceof ApiRequestError ? save.error : null;
  const available = knowledgeTags.data?.items ?? [];

  const setSecondaryAt = (index: number, value: string) =>
    setSecondaryKnowledge((prev) => {
      const next = [...prev];
      if (value === '') next.splice(index, 1);
      else next[index] = value;
      return next;
    });

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-medium">標籤</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          標籤與題目內容分開儲存，修改標籤不會產生新的題目版本。
        </p>
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {available.length === 0 && (
        <p className="text-sm text-muted-foreground">
          還沒有任何知識點。請先到{' '}
          <Link href="/tags" className="underline underline-offset-4">
            標籤管理
          </Link>{' '}
          建立。
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="主要知識點" hint="每題最多 1 個">
          <select
            className={selectClass}
            value={primaryKnowledge}
            onChange={(e) => setPrimaryKnowledge(e.target.value)}
          >
            <option value="">不指定</option>
            {available.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
                {tag.subjectName ? `（${tag.subjectName}）` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="主要能力類型" hint="每題最多 1 個">
          <select
            className={selectClass}
            value={primarySkill}
            onChange={(e) => setPrimarySkill(e.target.value)}
          >
            <option value="">不指定</option>
            {skillTags.data?.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((index) => (
          <Field key={index} label={`次要知識點 ${index + 1}`} hint={index === 0 ? '最多 2 個' : undefined}>
            <select
              className={selectClass}
              value={secondaryKnowledge[index] ?? ''}
              onChange={(e) => setSecondaryAt(index, e.target.value)}
            >
              <option value="">不指定</option>
              {available
                .filter(
                  (tag) =>
                    tag.id !== primaryKnowledge &&
                    !secondaryKnowledge.some((id, i) => id === tag.id && i !== index),
                )
                .map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
            </select>
          </Field>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? '儲存中…' : '儲存標籤'}
        </Button>
        {saved && <span className="text-sm text-emerald-700">已儲存</span>}
      </div>
    </Card>
  );
}
