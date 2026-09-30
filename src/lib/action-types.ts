export type ActionState<T = unknown> = { ok: boolean; error?: string; message?: string; data?: T; at?: number } | null;
