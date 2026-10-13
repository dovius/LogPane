// Small line icons drawn on a 24-unit grid (stroke and size come from .lv-icon in viewer.css). Inline SVG instead of
// text symbols like ⟳ or ⧉, which every system font draws differently, often tiny or not at all.

const PATHS = {
  reload: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6'],
  left: ['M15 6l-6 6 6 6'],
  right: ['M9 6l6 6-6 6'],
  copy: ['M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M4 15V5a2 2 0 0 1 2-2h10'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M20 20l-4.8-4.8'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, class: extra }: { name: IconName; class?: string }) {
  return (
    <svg class={extra ? `lv-icon ${extra}` : 'lv-icon'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}
