// Expand/collapse animation tests.
//
// `animateLayoutChange` is what makes the topic chip row and the poll description
// open and close instead of jumping between two layouts. It measures the block
// around the change it is asked to make and animates the height between the two
// heights, so what these tests pin down is the measurements it takes, the order of
// the layout changes, and that the block ends in the requested layout.

import { describe, expect, it, vi } from 'vitest';
import { animateLayoutChange } from '../src/ui';

// A stand-in for the animated element. The heights it reports are scripted, because
// the helper reads them around the change; `animate` captures the keyframes and
// hands back a listener holder so the test can settle the animation.
function makeElement(heights: number[], withAnimation = true) {
  let index = 0;
  const frames: Array<Array<Record<string, string>>> = [];
  const timings: Array<Record<string, unknown>> = [];
  const listeners: Record<string, () => void> = {};
  const style: Record<string, string> = { overflow: '' };
  let overflowAtStart: string | null = null;

  const element = {
    style,
    getBoundingClientRect: () => ({ height: heights[Math.min(index++, heights.length - 1)] }),
    ...(withAnimation
      ? {
        animate: (keyframes: Array<Record<string, string>>, timing: Record<string, unknown>) => {
          frames.push(keyframes);
          timings.push(timing);
          overflowAtStart = style.overflow;
          return {
            addEventListener: (type: string, listener: () => void) => {
              listeners[type] = listener;
            }
          };
        }
      }
      : {})
  } as unknown as HTMLElement;

  return {
    element,
    frames,
    timings,
    overflowAtStart: () => overflowAtStart,
    finish: () => listeners.finish?.(),
    cancel: () => listeners.cancel?.()
  };
}

describe('animateLayoutChange', () => {
  it('animates an expanding block from its current height to the new one', () => {
    const harness = makeElement([40, 100]);
    const states: boolean[] = [];

    animateLayoutChange(harness.element, true, (value) => states.push(value));

    // The block is put into the expanded layout before the height is measured.
    expect(states).toEqual([true]);
    expect(harness.frames).toEqual([[{ height: '40px' }, { height: '100px' }]]);
    expect(harness.timings[0]).toMatchObject({ duration: 200, easing: 'ease-out' });
    // It is clipped while it animates, so content on its way out does not poke out.
    expect(harness.overflowAtStart()).toBe('hidden');

    harness.finish();
    expect(states).toEqual([true, true]);
    expect(harness.element.style.overflow).toBe('');
  });

  it('measures the collapsed height and keeps the content until the box closes', () => {
    const harness = makeElement([100, 40]);
    const states: boolean[] = [];

    animateLayoutChange(harness.element, false, (value) => states.push(value));

    // The collapsed layout is applied to measure it, undone again so the content is
    // still there while the box closes, and applied for good once it has.
    expect(states).toEqual([false, true]);
    expect(harness.frames).toEqual([[{ height: '100px' }, { height: '40px' }]]);

    harness.cancel();
    expect(states).toEqual([false, true, false]);
    expect(harness.element.style.overflow).toBe('');
  });

  it('applies the change directly when there is no animation API', () => {
    const harness = makeElement([40], false);
    const states: boolean[] = [];

    animateLayoutChange(harness.element, true, (value) => states.push(value));

    expect(states).toEqual([true]);
    expect(harness.frames).toHaveLength(0);
  });

  it('applies the change directly when reduced motion is requested', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    try {
      const harness = makeElement([40, 100]);
      const states: boolean[] = [];

      animateLayoutChange(harness.element, true, (value) => states.push(value));

      expect(states).toEqual([true]);
      expect(harness.frames).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applies the change without animating when the height does not change', () => {
    const harness = makeElement([40, 40]);
    const states: boolean[] = [];

    animateLayoutChange(harness.element, true, (value) => states.push(value));

    expect(harness.frames).toHaveLength(0);
    expect(states).toEqual([true, true]);
  });
});
