import { useLayoutEffect, useRef, type RefObject } from 'react';

const GAP = 8;
const INSET = 12;

/** Keep the element in its scoped CSS/DOM tree, but render in the native top
 * layer: container-type, transforms and clipping ancestors must not become its
 * fixed containing block. Mount/show/measure in layout, before the first paint. */
export function useAnchoredPopup(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    const popup = panel.current;
    if (!anchor || !popup) return;
    // jsdom has no layout or popover API; browser geometry is tested in Chromium.
    if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover();
    const position = () => {
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + INSET;
      const top = (viewport?.offsetTop ?? 0) + INSET;
      const right = left + (viewport?.width ?? window.innerWidth) - INSET * 2;
      const bottom = top + (viewport?.height ?? window.innerHeight) - INSET * 2;
      const rect = anchor.getBoundingClientRect();
      // A top-layer popup must not outlive an anchor scrolled out of its own
      // clipping ancestor (even if that anchor is still inside the viewport).
      let visibleLeft = left - INSET, visibleTop = top - INSET;
      let visibleRight = right + INSET, visibleBottom = bottom + INSET;
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        // Client metrics are layout pixels; rects are viewport pixels. Convert
        // the inner clip box (including border/scrollbar offsets) on each axis
        // for positive axis-aligned scaling, including scaled ancestors.
        const scaleX = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
        const scaleY = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          visibleLeft = Math.max(visibleLeft, box.left + parent.clientLeft * scaleX);
          visibleRight = Math.min(visibleRight, box.left + (parent.clientLeft + parent.clientWidth) * scaleX);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          visibleTop = Math.max(visibleTop, box.top + parent.clientTop * scaleY);
          visibleBottom = Math.min(visibleBottom, box.top + (parent.clientTop + parent.clientHeight) * scaleY);
        }
      }
      if (rect.width && rect.height && (rect.bottom <= visibleTop || rect.top >= visibleBottom || rect.right <= visibleLeft || rect.left >= visibleRight)) {
        dismiss.current();
        return;
      }
      // Measuring the unconstrained height can temporarily reduce max scroll.
      // Preserve the user's/native Tab scroll when restoring the final bounds.
      const scrollTop = popup.scrollTop;
      popup.style.width = `${Math.max(0, Math.min(416, right - left))}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(576, bottom - top))}px`;
      const desired = popup.getBoundingClientRect().height;
      const below = Math.max(0, bottom - rect.bottom - GAP);
      const above = Math.max(0, rect.top - GAP - top);
      const flip = desired > below && above > below;
      popup.style.maxHeight = `${Math.min(576, flip ? above : below)}px`;
      const height = popup.getBoundingClientRect().height;
      popup.style.left = `${Math.max(left, Math.min(rect.left, right - popup.getBoundingClientRect().width))}px`;
      popup.style.top = `${Math.max(top, Math.min(flip ? rect.top - GAP - height : rect.bottom + GAP, bottom - height))}px`;
      popup.dataset.side = flip ? 'above' : 'below';
      popup.scrollTop = scrollTop;
    };
    const outside = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(anchor) && !path.includes(popup)) dismiss.current();
    };
    anchor.ownerDocument.addEventListener('pointerdown', outside, true);
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(popup);
    observer?.observe(anchor);
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) observer?.observe(parent);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer?.disconnect();
      anchor.ownerDocument.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      // Unmount removes the native popover. Do not hide/restore focus here:
      // cleanup can belong to an obsolete popup while another one is opening.
    };
  }, [open, trigger, panel]);
}
