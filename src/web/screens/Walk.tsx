import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type WalkDetail } from '../api';
import { Progress } from './Progress';
import { Ready } from './Ready';

export function Walk({ id }: { id: string }) {
  const [detail, setDetail] = useState<WalkDetail | null>(null);
  const [problem, setProblem] = useState<'missing' | 'offline' | null>(null);
  const sawProgress = useRef(false);

  const load = useCallback(() => {
    api.walk(id).then(
      (d) => {
        setProblem(null);
        setDetail(d);
      },
      (err: unknown) => setProblem(err instanceof ApiError && err.status === 404 ? 'missing' : 'offline'),
    );
  }, [id]);

  useEffect(load, [load]);
  const gone = useCallback(() => setProblem('missing'), []);

  if (problem === 'missing') {
    return (
      <div className="page">
        <h1>There is no walk here.</h1>
        <p className="lede">
          It may have been cancelled. <a href="/">Make a new Walk Edition</a>.
        </p>
      </div>
    );
  }
  if (problem === 'offline' && !detail) {
    return (
      <div className="page">
        <h1>The app is not answering.</h1>
        <p className="lede">Start it again in the terminal with npm start, then reload this page. Finished steps are kept.</p>
      </div>
    );
  }
  if (!detail) return <div className="page" aria-busy="true" />;
  if (detail.ready) return <Ready detail={detail} arrived={sawProgress.current} />;
  sawProgress.current = true;
  return <Progress detail={detail} onDone={load} onGone={gone} />;
}
