import { atom } from "jotai";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastEntry {
  id: string;
  message: string;
  title?: string;
  tone?: ToastTone;
  createdAt: number;
  durationMs?: number;
}

export type ToastInput = Omit<ToastEntry, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

export const toastQueueAtom = atom<ToastEntry[]>([]);

export const pushToastAtom = atom(null, (_get, set, toast: ToastInput) => {
  const entry: ToastEntry = {
    id: toast.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    message: toast.message,
    title: toast.title,
    tone: toast.tone ?? "info",
    createdAt: toast.createdAt ?? Date.now(),
    durationMs: toast.durationMs,
  };
  set(toastQueueAtom, (queue) => [...queue, entry]);
});

export const dismissToastAtom = atom(null, (_get, set, id: string) => {
  set(toastQueueAtom, (queue) => queue.filter((toast) => toast.id !== id));
});
