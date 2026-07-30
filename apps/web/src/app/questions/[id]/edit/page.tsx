'use client';

import type { QuestionResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { use } from 'react';

import { AppShell } from '@/components/app-shell';
import { QuestionForm } from '@/components/question-form';
import { ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function EditQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const question = useQuery({
    queryKey: ['questions', id],
    queryFn: () => api.get<QuestionResponse>(`/questions/${id}`),
    retry: false,
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">編輯題目</h1>

        {question.isPending && <p className="text-sm text-muted-foreground">載入中…</p>}
        {question.error instanceof ApiRequestError && (
          <ErrorBanner message={question.error.message} />
        )}
        {question.data && (
          <>
            <p className="text-sm text-muted-foreground">
              目前版本 v{question.data.currentVersion}．每次儲存都會寫入一筆版本快照。
            </p>
            <QuestionForm existing={question.data} />
          </>
        )}
      </div>
    </AppShell>
  );
}
