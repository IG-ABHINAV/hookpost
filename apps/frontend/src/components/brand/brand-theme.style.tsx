import { brandThemeCss } from '@hookpost/helpers/brand/brand-themes';

/**
 * The brand tokens (--hp-*) for every theme, keyed by html[data-brand-theme].
 * Rendered in the <head> of each root layout, next to
 * `<html {...brandHtmlAttributes()}>`, which picks the active one.
 * See libraries/helpers/src/brand/brand-themes.ts.
 */
export const BrandThemeStyle = () => (
  <style
    id="hp-brand-themes"
    dangerouslySetInnerHTML={{ __html: brandThemeCss() }}
  />
);
