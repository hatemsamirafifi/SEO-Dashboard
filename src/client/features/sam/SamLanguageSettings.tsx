import type { TextDirection } from "@/client/components/chat/bidiText";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { samReplyLanguageSchema } from "@/shared/samReplyLanguage";

const STORAGE_KEY = "openseo:sam:language-settings";
const CHANGE_EVENT = "sam-language-settings-change";
const layoutSchema = z.enum(["auto", "ltr", "rtl"]);
const settingsSchema = z.object({
  replyLanguage: samReplyLanguageSchema.catch("auto"),
  layout: layoutSchema.catch("auto"),
});

type Settings = z.infer<typeof settingsSchema>;
const defaults: Settings = { replyLanguage: "auto", layout: "auto" };
const defaultSnapshot = JSON.stringify(defaults);
let inMemorySnapshot: string | undefined;

function readSnapshot() {
  if (inMemorySnapshot !== undefined) return inMemorySnapshot;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? defaultSnapshot;
  } catch {
    return defaultSnapshot;
  }
}

function subscribe(onChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  }
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("languagechange", onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("languagechange", onChange);
  };
}

function layoutForBrowser(): TextDirection {
  return navigator.language.toLowerCase().split("-")[0] === "ar"
    ? "rtl"
    : "ltr";
}

function readSettings(snapshot: string): Settings {
  try {
    const result = settingsSchema.safeParse(JSON.parse(snapshot));
    return result.success ? result.data : defaults;
  } catch {
    return defaults;
  }
}

export function useSamLanguageSettings() {
  const snapshot = useSyncExternalStore(
    subscribe,
    readSnapshot,
    () => defaultSnapshot,
  );
  const browserDirection = useSyncExternalStore<TextDirection>(
    subscribe,
    layoutForBrowser,
    () => "ltr",
  );
  const settings = readSettings(snapshot);

  function updateSettings(changes: Partial<Settings>) {
    const nextSnapshot = JSON.stringify({
      ...readSettings(readSnapshot()),
      ...changes,
    });
    try {
      window.localStorage.setItem(STORAGE_KEY, nextSnapshot);
      inMemorySnapshot = undefined;
    } catch {
      inMemorySnapshot = nextSnapshot;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  const direction =
    settings.layout === "auto" ? browserDirection : settings.layout;
  return {
    ...settings,
    direction,
    updateSettings,
  };
}

export function SamLanguageSettings({
  replyLanguage,
  layout,
  updateSettings,
}: Pick<
  ReturnType<typeof useSamLanguageSettings>,
  "replyLanguage" | "layout" | "updateSettings"
>) {
  return (
    <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs">
      <label className="flex items-center gap-1.5">
        Reply language
        <select
          className="select select-xs w-auto"
          value={replyLanguage}
          onChange={(event) =>
            updateSettings({
              replyLanguage: samReplyLanguageSchema.parse(event.target.value),
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="ar" lang="ar">
            العربية
          </option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        SAM layout
        <select
          className="select select-xs w-auto"
          value={layout}
          onChange={(event) =>
            updateSettings({ layout: layoutSchema.parse(event.target.value) })
          }
        >
          <option value="auto">Auto</option>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left</option>
        </select>
      </label>
    </div>
  );
}
