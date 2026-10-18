"use server";

import { signInWithPassword } from "@ssos/auth";

export interface SignInState {
  error: "invalid" | null;
  email: string;
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  // On success this redirects to "/", which routes the user to the right school.
  const result = await signInWithPassword(email, password, "/");
  return result.ok ? { error: null, email } : { error: "invalid", email };
}
