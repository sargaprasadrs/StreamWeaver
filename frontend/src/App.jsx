import React, { useCallback, useEffect, useState } from 'react';
import UploadDropzone from './components/upload/UploadDropzone.jsx';
import VirtualCsvGrid from './components/grid/VirtualCsvGrid.jsx';
import { fetchSample } from './lib/api.js';

export default function App() {
  const [sample, setSample] = useState(null);
  const [sampleError, setSampleError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadSample = useCallback(async (uploadId) => {
    setLoading(true);
    setSampleError(null);
    setSample(null);
    try {
      const data = await fetchSample(uploadId);
      setSample(data);
    } catch (err) {
      setSampleError(err.message || 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'StreamWeaver — Streaming ETL';
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>StreamWeaver</h1>
        <p className="app-subtitle">Memory-safe streaming ETL for massive datasets</p>
      </header>

      <UploadDropzone onUploaded={(res) => loadSample(res.uploadId)} />

      <section className="panel">
        <h2>Preview</h2>
        {loading && <p>Loading preview…</p>}
        {sampleError && (
          <p className="alert alert--error" role="alert">
            {sampleError}
          </p>
        )}
        {sample && (
          <VirtualCsvGrid columns={sample.columns} rows={sample.rows} truncated={sample.truncated} />
        )}
        {!sample && !loading && !sampleError && (
          <p className="grid-empty">Upload a CSV to preview its first 1,000 rows.</p>
        )}
      </section>
    </div>
  );
}
