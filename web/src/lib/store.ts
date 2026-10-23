import { create } from 'zustand';

type Theme = 'dark' | 'light';
interface AppState {
  theme: Theme;
  toggleTheme: () => void;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
}

const stored = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const applyTheme = (t: Theme) => { document.documentElement.classList.toggle('dark', t === 'dark'); };

const initialTheme = stored<Theme>('minion.theme', window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
applyTheme(initialTheme);

export const useApp = create<AppState>((set, get) => ({
  theme: initialTheme,
  toggleTheme: () => { const t: Theme = get().theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('minion.theme', JSON.stringify(t)); applyTheme(t); set({ theme: t }); },
  projectId: stored<string | null>('minion.project', null),
  setProjectId: (id) => { localStorage.setItem('minion.project', JSON.stringify(id)); set({ projectId: id }); },
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
}));
