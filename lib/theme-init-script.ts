import { THEMES, SYSTEM_CHOICE_ID, DEFAULT_CHOICE_ID } from "@/lib/themes";

/**
 * Inline <head> script that applies the saved theme before first paint, so a
 * dark-OS user on the default "System" choice doesn't see a light flash while
 * React hydrates. Mirrors the storage keys and resolution in
 * components/theme-provider.tsx — keep the two in sync.
 */
export function themeInitScript(): string {
  const palettes = Object.fromEntries(THEMES.map((t) => [t.id, t.mode]));
  return `(function(){try{
var P=${JSON.stringify(palettes)};
var m=location.pathname.match(/^\\/p\\/([^/]+)/);
var s=localStorage,k=m?"bmus.theme."+decodeURIComponent(m[1]):"bmus.theme";
var c=s.getItem(k)||s.getItem("bmus-theme");
if(c!=="${SYSTEM_CHOICE_ID}"&&!(c in P))c="${DEFAULT_CHOICE_ID}";
var id=c;
if(c==="${SYSTEM_CHOICE_ID}")id=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
var d=document.documentElement;
d.dataset.theme=id;
d.classList.toggle("dark",P[id]==="dark");
}catch(e){}})();`;
}
