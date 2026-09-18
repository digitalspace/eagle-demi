import type { CSSProperties } from 'react';

// The Angular templates carry these as inline style attributes on every button and box. Written
// once here so the same declarations are not repeated per screen; the rendered result is identical.

export const primaryButton: CSSProperties = {
  background: 'var(--surface-color-primary-default)',
  color: 'var(--surface-color-background-white)',
  border: 'none',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.55rem 1.1rem',
  font: 'var(--typography-bold-small-body)',
  cursor: 'pointer',
};

export const secondaryButton: CSSProperties = {
  background: 'var(--surface-color-background-white)',
  color: 'var(--surface-color-primary-default)',
  border: 'var(--layout-border-width-small) solid var(--surface-color-primary-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.55rem 1.1rem',
  font: 'var(--typography-bold-small-body)',
  cursor: 'pointer',
};

/** A row action that reads as a link but stays a button. */
export const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'var(--typography-regular-small-body)',
  color: 'var(--surface-color-primary-default)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

export const textInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.5rem 0.7rem',
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-body)',
};

export const checkbox: CSSProperties = { flex: '0 0 auto', marginTop: 3 };

export const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--layout-margin-medium)',
};
