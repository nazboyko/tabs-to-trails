import { useCallback, useEffect, useState } from 'react';
import { api, type WalkDetail } from '../api';
import { Progress } from './Progress';
import { Ready } from './Ready';

export function Walk({ id }: { id: string }) {
  const [detail, setDetail] = useState<WalkDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => {
    api.walk(id).then(setDetail, () => setMissing(true));
  }, [id]);

  useEffect(load, [load]);

  if (missing) {
    return (
      <div className="page">
        <h1>There is no walk here.</h1>
        <p className="lede">
          It may have been cancelled. <a href="/">Make a new Walk Edition</a>.
        </p>
      </div>
    );
  }
  if (!detail) return <div className="page" aria-busy="true" />;
  if (detail.ready) return <Ready detail={detail} />;
  return <Progress detail={detail} onDone={load} />;
}
