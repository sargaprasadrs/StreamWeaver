import React, { useCallback, useEffect, useRef, useState } from 'react';
import UploadDropzone from './components/upload/UploadDropzone.jsx';
import VirtualCsvGrid from './components/grid/VirtualCsvGrid.jsx';
import MappingBoard from './components/mapping/MappingBoard.jsx';
import TransformEditor from './components/transform/TransformEditor.jsx';
import ProgressBar from './components/progress/ProgressBar.jsx';
import JobSummary from './components/summary/JobSummary.jsx';
import FailedRowsPanel from './components/errors/FailedRowsPanel.jsx';
import { fetchSample } from './lib/api.js';
import { subscribeProgress } from './lib/ws.js';

export default function App() {
  const [sample, setSample] = useState(null);
  const [sampleError, setSampleError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [transform, setTransform] = useState(null);
  const [run, setRun] = useState({ active: false, uploadId: null, status: 'processing', data: {} });
  const [summary, setSummary] = useState(null);
  const [errorsToken, setErrorsToken] = useState(0);
  const unsubscribeRef = useRef(null);

  const stopStream = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  useEffect(() => {
    document.title = 'StreamWeaver — Streaming ETL';
  }, []);

  const loadSample = useCallback(
    async (uploadId) => {
      stopStream();
      setLoading(true);
      setSampleError(null);
      setSample(null);
      setSummary(null);
      setRun({ active: false, uploadId: null, status: 'processing', data: {} });
      try {
        const data = await fetchSample(uploadId);
        setSample(data);
      } catch (err) {
        setSampleError(err.message || 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    },
    [stopStream]
  );

  const onRunStart = useCallback(
    (uploadId) => {
      setSummary(null);
      setRun({ active: true, uploadId, status: 'processing', data: { rowsProcessed: 0 } });
      stopStream();
      unsubscribeRef.current = subscribeProgress(uploadId, (msg) => {
        if (msg.terminal) {
          setRun((prev) => ({
            ...prev,
            active: false,
            status: msg.status || 'completed',
            data: { ...prev.data, ...msg },
          }));
          if (msg.status === 'completed') setSummary((prev) => ({ ...msg, ...(prev || {}) }));
          setErrorsToken((t) => t + 1);
          return;
        }
        setRun((prev) => ({ ...prev, data: { ...prev.data, ...msg } }));
      });
    },
    [stopStream]
  );

  const onRunFinish = useCallback(
    (result, err) => {
      stopStream();
      if (result) {
        setSummary(result);
        setRun((prev) => ({
          ...prev,
          active: false,
          status: 'completed',
          data: { ...prev.data, ...result, rowsProcessed: result.rowsProcessed },
        }));
      } else {
        setRun((prev) => ({ ...prev, active: false, status: 'failed', data: { ...prev.data, error: err && err.message } }));
      }
      setErrorsToken((t) => t + 1);
    },
    [stopStream]
  );

  const progressData = { ...run.data, status: run.status };

  return (
    <div className="app">
      <header className="app-header">
        <h1>StreamWeaver</h1>
        <p className="app-subtitle">Memory-safe streaming ETL for massive datasets</p>
      </header>

      <UploadDropzone onUploaded={(res) => loadSample(res.uploadId)} />

      {loading && (
        <section className="panel">
          <p>Loading preview…</p>
        </section>
      )}
      {sampleError && (
        <section className="panel">
          <p className="alert alert--error" role="alert">
            {sampleError}
          </p>
        </section>
      )}

      {sample && (
        <>
          <section className="panel">
            <h2>Preview</h2>
            <VirtualCsvGrid columns={sample.columns} rows={sample.rows} truncated={sample.truncated} />
          </section>

          <TransformEditor columns={sample.columns} value={transform} onChange={setTransform} />

          <MappingBoard
            uploadId={sample.uploadId}
            columns={sample.columns}
            rows={sample.rows}
            transform={transform}
            onRunStart={onRunStart}
            onRunFinish={onRunFinish}
          />

          {run.active && <ProgressBar {...progressData} />}
          <JobSummary summary={summary} />
          {summary && summary.rowsFailed > 0 && (
            <FailedRowsPanel uploadId={sample.uploadId} refreshToken={errorsToken} />
          )}
        </>
      )}

      {!sample && !loading && !sampleError && (
        <section className="panel">
          <p className="grid-empty">Upload a CSV to preview its first 1,000 rows and map its columns.</p>
        </section>
      )}
    </div>
  );
}
