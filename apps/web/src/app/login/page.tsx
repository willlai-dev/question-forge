'use client';

import { loginRequestSchema, type LoginRequest, type UserResponse } from '@repo/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Card, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();

  // 尚未初始化時導向 /setup，避免使用者卡在一個永遠登不進去的畫面。
  const { data } = useQuery({
    queryKey: ['auth', 'bootstrap-status'],
    queryFn: () => api.get<{ canBootstrap: boolean }>('/auth/bootstrap'),
    retry: false,
  });

  useEffect(() => {
    if (data?.canBootstrap) router.replace('/setup');
  }, [data, router]);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { username: '', password: '' },
  });

  const mutation = useMutation({
    mutationFn: (values: LoginRequest) => api.post<UserResponse>('/auth/login', values),
    onSuccess: () => router.replace('/subjects'),
  });

  const serverError = mutation.error instanceof ApiRequestError ? mutation.error : null;

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight">登入</h1>
      <p className="mt-2 text-sm text-muted-foreground">題庫分析系統</p>

      <Card className="mt-8">
        <form
          className="space-y-5"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          {serverError && <ErrorBanner message={serverError.message} />}

          <Field label="帳號" error={form.formState.errors.username?.message}>
            <Input {...form.register('username')} autoComplete="username" autoFocus />
          </Field>

          <Field label="密碼" error={form.formState.errors.password?.message}>
            <Input type="password" {...form.register('password')} autoComplete="current-password" />
          </Field>

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? '登入中…' : '登入'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
