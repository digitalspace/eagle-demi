export type Zoom = 'whole' | '10' | '5' | '2' | '1';

/** The five time scales both pages offer; `years` 0 fits the whole range in the view. */
export const ZOOMS: { value: Zoom; label: string; years: number }[] = [
  { value: 'whole', label: 'Whole range', years: 0 },
  { value: '10', label: '10 years', years: 10 },
  { value: '5', label: '5 years', years: 5 },
  { value: '2', label: '2 years', years: 2 },
  { value: '1', label: '1 year', years: 1 },
];
