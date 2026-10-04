// Global language toggle (中文 / EN). Mirrors UnitToggle: a compact segmented
// control that sits in the header row. The choice is persisted by App.
import { LANGS, useT } from "../i18n";

export default function LangToggle({ lang, onChange }) {
  const t = useT();
  return (
    <div className="unit-toggle" role="group" aria-label={t("app.langAria")}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={lang === l.id ? "active" : ""}
          onClick={() => onChange(l.id)}
          aria-pressed={lang === l.id}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
