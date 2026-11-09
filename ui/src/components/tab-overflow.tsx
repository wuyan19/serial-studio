import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export function TabOverflow({ scrollRef, children }: {
  scrollRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, before: false, after: false });
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const scroll = scrollRef.current;
    if (!strip || !scroll) return;
    const measure = () => {
      // Compare against the full strip so controls cannot create their own overflow.
      const overflow = scroll.scrollWidth > strip.clientWidth + 1;
      const before = overflow && scroll.scrollLeft > 1;
      const after = overflow && scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft > 1;
      setEdges(previous => previous.overflow === overflow && previous.before === before && previous.after === after
        ? previous : { overflow, before, after });
    };
    const resize = new ResizeObserver(() => {
      const active = scroll.querySelector<HTMLElement>(".tab[data-active='true']");
      if (active) {
        const tab = active.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        if (tab.left < viewport.left) scroll.scrollLeft += tab.left - viewport.left;
        else if (tab.right > viewport.right) scroll.scrollLeft += tab.right - viewport.right;
      }
      measure();
    });
    const observeTabs = () => {
      resize.disconnect();
      resize.observe(strip);
      resize.observe(scroll);
      Array.from(scroll.children).forEach(tab => resize.observe(tab));
      measure();
    };
    const mutations = new MutationObserver(observeTabs);
    mutations.observe(scroll, { childList: true, characterData: true, subtree: true });
    scroll.addEventListener("scroll", measure, { passive: true });
    observeTabs();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      scroll.removeEventListener("scroll", measure);
    };
  }, [scrollRef]);
  const page = (direction: number) => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollBy({ left: direction * Math.max(1, scroll.clientWidth * .75), behavior: "smooth" });
  };
  return <div ref={stripRef} className="tab-strip">
    <div className="tab-strip__window" data-before={edges.before || undefined} data-after={edges.after || undefined}>
      {children}
    </div>
    {edges.overflow && <div className="tab-strip__controls" role="group" aria-label="标签栏滚动">
      <button type="button" className="tab-strip__arrow" aria-label="查看前面的标签" title={edges.before ? "查看前面的标签" : "已到第一个标签"} disabled={!edges.before} onClick={() => page(-1)}>‹</button>
      <button type="button" className="tab-strip__arrow" aria-label="查看后面的标签" title={edges.after ? "后面还有标签，点击继续查看" : "已到最后一个标签"} disabled={!edges.after} onClick={() => page(1)}>›</button>
    </div>}
  </div>;
}
