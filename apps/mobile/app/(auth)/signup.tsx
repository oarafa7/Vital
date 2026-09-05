/**
 * Sign Up — full name, email, password, Egyptian phone, with real-time Zod
 * validation, a terms checkbox, and a Google OAuth affordance.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { type SignupInput, signupSchema } from '@vital/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';

import { Button, FormField, LucideIcon, Screen, toast } from '@/components/ui';
import { colors } from '@/constants/theme';
import { ApiError, authApi } from '@/lib/api';
import { useAuthStore } from '@/lib/store/auth';

export default function SignUp() {
  const router = useRouter();
  const applySession = useAuthStore((s) => s.applySession);
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    mode: 'onChange',
    defaultValues: {
      full_name: '',
      email: '',
      password: '',
      phone: '+20',
      accepted_terms: false as unknown as true,
    },
  });

  const acceptedTerms = watch('accepted_terms');

  const onSubmit = async (data: SignupInput) => {
    setSubmitting(true);
    try {
      const res = await authApi.signup(data);
      if (!res.access_token || !res.refresh_token) {
        // The API cannot return a 201 without a complete session; guard anyway
        // rather than walking into onboarding signed out, where every request
        // 401s and the user ends up bounced back to login.
        toast.error('Your account was created, but we could not sign you in. Please sign in.');
        router.replace('/(auth)/login');
        return;
      }
      await applySession(res.access_token, res.refresh_token, res.user);
      router.replace('/(auth)/health-profile');
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[VITAL] signup failed', err);
      }
      const message = err instanceof ApiError ? err.message : 'Could not create account';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll>
      <Text className="mb-1 mt-6 font-display" style={{ color: colors.white, fontSize: 34 }}>
        Create account
      </Text>
      <Text className="mb-8 font-body" style={{ color: colors.textDim, fontSize: 14 }}>
        Start tracking the markers that matter.
      </Text>

      <FormField control={control} name="full_name" label="Full name" autoCapitalize="words" error={errors.full_name?.message} />
      <FormField control={control} name="email" label="Email" keyboardType="email-address" error={errors.email?.message} />
      <FormField control={control} name="password" label="Password" secureTextEntry error={errors.password?.message} />
      <FormField control={control} name="phone" label="Phone (+20)" keyboardType="phone-pad" error={errors.phone?.message} />

      <Pressable
        onPress={() => setValue('accepted_terms', !acceptedTerms as true, { shouldValidate: true })}
        className="mb-6 flex-row items-center"
      >
        <View
          className="mr-3 items-center justify-center rounded-sm border"
          style={{
            width: 22,
            height: 22,
            borderColor: acceptedTerms ? colors.gold : colors.borderLight,
            backgroundColor: acceptedTerms ? colors.gold : 'transparent',
          }}
        >
          {acceptedTerms ? <LucideIcon name="Check" size={14} color={colors.obsidian} /> : null}
        </View>
        <Text className="flex-1 font-body" style={{ color: colors.text, fontSize: 13 }}>
          I agree to the Terms of Service and Privacy Policy
        </Text>
      </Pressable>
      {errors.accepted_terms ? (
        <Text className="-mt-4 mb-4 font-body" style={{ color: colors.red, fontSize: 12 }}>
          {errors.accepted_terms.message}
        </Text>
      ) : null}

      <Button label="Continue" onPress={handleSubmit(onSubmit)} loading={submitting} />

      <View className="my-5 flex-row items-center">
        <View className="flex-1" style={{ height: 1, backgroundColor: colors.border }} />
        <Text className="mx-3 font-mono" style={{ color: colors.textMuted, fontSize: 11 }}>
          OR
        </Text>
        <View className="flex-1" style={{ height: 1, backgroundColor: colors.border }} />
      </View>

      <Button
        label="Continue with Google"
        variant="secondary"
        icon="Chrome"
        onPress={() => toast.info('Google sign-in opens via Supabase OAuth')}
      />

      <Pressable className="mt-6 items-center" onPress={() => router.replace('/(auth)/login')}>
        <Text className="font-body" style={{ color: colors.textDim, fontSize: 13 }}>
          Already have an account? <Text style={{ color: colors.gold }}>Sign in</Text>
        </Text>
      </Pressable>
    </Screen>
  );
}
