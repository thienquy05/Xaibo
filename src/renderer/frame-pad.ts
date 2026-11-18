// XAIBO-PROD-439 (P4-T15b; WCAG 2.4.11, design §2.3/§6.0): the scroll padding that keeps focus out from under the
// sticky top frame. Below 1200 CSS px the frame is a top bar whose height varies (wrapping nav, large text): reserve it
// plus 8 px for the focus ring; at 1200 px and wider the frame is the left rail and nothing sits above content.
// A short viewport (tokens.css max-height 480px) makes the frame scroll away: nothing to clear then.
export const framePad = (frameHeight: number, width: number, sticky: boolean): number => (width >= 1200 || !sticky ? 8 : frameHeight + 8);
