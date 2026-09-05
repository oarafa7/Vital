'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type SignupInput, signupSchema } from '@vital/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { useToast } from '@/components/toast';
import { Button, Card, Checkbox, Field, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function SignupPage() {
  const { signup } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    mode: 'onBlur',
    defaultValues: {
      full_name: '',
      email: '',
      password: '',
      phone: '+20',
      accepted_terms: false as unknown as true,
    },
  });

  const onSubmit = async (data: SignupInput) => {
    setSubmitting(true);
    try {
      // Resolves only with a complete session, so reaching the next line means
      // the user really is signed in. Anything else throws.
      await signup(data);
      router.replace('/onboarding/health-profile');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.kind === 'conflict') {
          // The API distinguishes a duplicate email from a duplicate phone;
          // use its message rather than assuming which field collided.
          toast.error(err.message);
        } else if (err.kind === 'network') {
          toast.error('Could not reach the VITAL server. Is the API running?');
        } else {
          // Validation failures from the API carry a specific, user-facing message.
          toast.error(err.message);
        }
      } else {
        toast.error('Could not create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-7 sm:p-8">
      <h1 className="font-display text-3xl text-ink">Create account</h1>
      <p className="mb-7 mt-1 text-sm text-inkSoft">Start tracking the markers that matter.</p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <Field label="Full name" error={errors.full_name?.message} htmlFor="full_name">
          <Input
            id="full_name"
            autoComplete="name"
            placeholder="Your name"
            invalid={!!errors.full_name}
            {...register('full_name')}
          />
        </Field>

        <Field label="Email" error={errors.email?.message} htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            invalid={!!errors.email}
            {...register('email')}
          />
        </Field>

        <Field
          label="Password"
          error={errors.password?.message}
          hint="At least 8 characters, with an uppercase letter and a number."
          htmlFor="password"
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            invalid={!!errors.password}
            {...register('password')}
          />
        </Field>

        <Field
          label="Phone"
          error={errors.phone?.message}
          hint="Egyptian mobile number, e.g. +201012345678"
          htmlFor="phone"
        >
          <Input
            id="phone"
            type="tel"
            autoComplete="tel"
            placeholder="+201012345678"
            invalid={!!errors.phone}
            {...register('phone')}
          />
        </Field>

        <div className="mb-6">
          <Controller
            control={control}
            name="accepted_terms"
            render={({ field }) => (
              <Checkbox
                id="accepted_terms"
                checked={!!field.value}
                onChange={(next) => field.onChange(next as true)}
                label="I agree to the Terms of Service and Privacy Policy"
              />
            )}
          />
          {errors.accepted_terms ? (
            <p className="mt-1.5 text-xs text-rust" role="alert">
              {errors.accepted_terms.message}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" loading={submitting}>
          Continue
        </Button>
      </form>

      <p className="mt-6 text-center text-[13px] text-inkSoft">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
