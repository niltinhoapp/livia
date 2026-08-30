interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  desc?: string;
}

export function Toggle({ checked, onChange, title, desc }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2.5">
      <span className="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-primary" />
        <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </span>
      <span>
        <span className="block text-sm font-semibold text-ink-700">{title}</span>
        {desc && <span className="block text-sm text-ink-500">{desc}</span>}
      </span>
    </label>
  );
}
