import { useEffect, useRef, useState } from 'react';

const films = [
  { title: 'Afternoon, unhurried', video: '/art/home-reel/afternoon-room.mp4', poster: '/art/home-reel/afternoon-room.webp' },
  { title: 'Light and form', video: '/art/home-reel/desert-light.mp4', poster: '/art/home-reel/desert-light.webp' },
  { title: 'Before the last bus', video: '/art/home-reel/last-bus.mp4', poster: '/art/home-reel/last-bus.webp' },
] as const;

export function HomeShowreel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playEpoch = useRef(0);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(() => typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  const wantsPlayback = useRef(!paused);
  wantsPlayback.current = !paused;
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const film = films[active]!;
  const play = (video: HTMLVideoElement) => {
    const epoch = ++playEpoch.current;
    const rejected = () => { if (videoRef.current === video && playEpoch.current === epoch && document.visibilityState !== 'hidden') setPaused(true); };
    try { void Promise.resolve(video.play()).then(() => {
      if (videoRef.current !== video || !wantsPlayback.current || document.visibilityState === 'hidden') video.pause();
    }).catch(rejected); }
    catch { rejected(); }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused || document.visibilityState === 'hidden') {
      ++playEpoch.current;
      video.pause();
      return;
    }
    play(video);
    return () => { ++playEpoch.current; video.pause(); };
  }, [active, paused, failed]);

  useEffect(() => {
    const onVisibility = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.visibilityState === 'hidden') { ++playEpoch.current; video.pause(); }
      else if (!paused) play(video);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [paused]);

  const select = (index: number) => setActive((index + films.length) % films.length);
  return <section className="fl-showreel" role="region" aria-label="Featured films">
    <div className="fl-showreel__media">
      {failed[active]
        ? <div className="fl-showreel__error" role="status" aria-label={`${film.title} unavailable`} style={{ backgroundImage: `linear-gradient(rgb(5 8 8 / .72), rgb(5 8 8 / .9)), url(${film.poster})` }}><span>This film could not be played.</span></div>
        : <video key={film.video} ref={videoRef} aria-label={film.title} src={film.video} poster={film.poster} muted playsInline preload="metadata" onEnded={() => { if (!paused && document.visibilityState !== 'hidden') select(active + 1); }} onError={() => setFailed(value => ({ ...value, [active]: true }))} />}
    </div>
    <div className="fl-showreel__caption">
      <div><p className="fl-eyebrow">Featured film · {String(active + 1).padStart(2, '0')}</p><h2>{film.title}</h2></div>
      <div className="fl-showreel__controls">
        <button type="button" aria-label="Previous film" onClick={() => select(active - 1)}>←</button>
        <button type="button" disabled={!!failed[active]} aria-label={paused ? 'Resume showreel' : 'Pause showreel'} onClick={() => setPaused(value => !value)}>{paused ? 'Play' : 'Pause'}</button>
        <button type="button" aria-label="Next film" onClick={() => select(active + 1)}>→</button>
      </div>
    </div>
    <div className="fl-showreel__dots" role="group" aria-label="Choose a featured film">
      {films.map((item, index) => <button key={item.video} type="button" aria-label={`Show ${item.title}`} aria-current={index === active ? 'true' : undefined} onClick={() => select(index)}><span aria-hidden="true" /></button>)}
    </div>
  </section>;
}
