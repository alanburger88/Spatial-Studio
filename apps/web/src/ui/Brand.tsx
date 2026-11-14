import onLight from '../assets/brand/infoslips-logo-on-light.png';
import onDark from '../assets/brand/infoslips-logo-on-dark.png';
import icon from '../assets/brand/infoslips-icon.png';

/**
 * Official InfoSlips logo artwork (see assets/brand/README.md). Rendered as supplied: never redrawn or recoloured.
 * `full` shows the mark and wordmark, switching artwork with the theme; `icon` shows the mark alone for tight spaces.
 * Decorative by default (the surrounding link or heading names the product); pass `alt` where it stands alone.
 */
export function BrandLogo({ variant = 'full', height = 30, alt = '' }: { variant?: 'full' | 'icon'; height?: number; alt?: string }) {
  if (variant === 'icon') return <img className="brand-img brand-img-icon" src={icon} alt={alt} height={height} width={Math.round(height * (140 / 135))} data-testid="brand-icon" />;
  const width = Math.round(height * (576 / 136));
  return (
    <span className="brand-img-full" data-testid="brand-logo">
      <img className="brand-img on-light" src={onLight} alt={alt} height={height} width={width} />
      <img className="brand-img on-dark" src={onDark} alt="" aria-hidden="true" height={height} width={width} />
    </span>
  );
}
