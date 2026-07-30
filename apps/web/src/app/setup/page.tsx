'use client';

import { bootstrapRequestSchema, type BootstrapRequest, type UserResponse } from '@repo/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Card, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

/**
 * 首次啟動的初始化頁面。
 *
 * 帳號建立完成後後端會永久停用此端點，因此本頁在偵測到
 * canBootstrap 為 false 時會直接導向登入頁。
 * 密碼只在此輸入一次並立刻雜湊，不需要、也不應該寫進 .env。
 */
export default function SetupPage() {
  const router = useRouter();

  const { data, isPending } = useQuery({
    queryKey: ['auth', 'bootstrap-status'],
    queryFn: () => api.get<{ canBootstrap: boolean }>('/auth/bootstrap'),
    retry: false,
  });

  useEffect(() => {
    if (data && !data.canBootstrap) router.replace('/login');
  }, [data, router]);

  const form = useForm<BootstrapRequest>({
    resolver: zodResolver(bootstrapRequestSchema),
    defaultValues: { username: '', password: '', confirmPassword: '', displayName: '' },
  });

  const mutation = useMutation({
    mutationFn: (values: BootstrapRequest) => api.post<UserResponse>('/auth/bootstrap', values),
    onSuccess: () => router.replace('/subjects'),
  });

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;

  if (isPending) {
    return <main className="p-16 text-center text-sm text-muted-foreground">載入中…</main>;
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight">建立你的帳號</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        這是系統的首次啟動。建立帳號後，本頁面會永久停用。
      </p>

      <Card className="mt-8 space-y-5">
        <form
          className="space-y-5"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          {serverError && <ErrorBanner message={serverError.message} />}

          <Field label="帳號" error={form.formState.errors.username?.message}>
            <Input {...form.register('username')} autoComplete="username" autoFocus />
          </Field>

          <Field label="顯示名稱（選填）" error={form.formState.errors.displayName?.message}>
            <Input {...form.register('displayName')} autoComplete="nickname" />
          </Field>

          <Field
            label="密碼"
            hint="至少 12 個字元，且不得與帳號相同。"
            error={form.formState.errors.password?.message ?? serverError?.fieldError('password')}
          >
            <Input type="password" {...form.register('password')} autoComplete="new-password" />
          </Field>

          <Field
            label="確認密碼"
            error={
              form.formState.errors.confirmPassword?.message ??
              serverError?.fieldError('confirmPassword')
            }
          >
            <Input
              type="password"
              {...form.register('confirmPassword')}
              autoComplete="new-password"
            />
          </Field>

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? '建立中…' : '建立帳號'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
