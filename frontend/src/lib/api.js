const API_BASE = '/api';

/**
 * Fetch the first-rows sample for an uploaded CSV.
 */
export async function fetchSample(uploadId, signal) {
  const res = await fetch(`${API_BASE}/uploads/${encodeURIComponent(uploadId)}/sample`, { signal });
  if (!res.ok) {
    let msg = `Sample request failed (${res.status})`;
    let details;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
      details = body && body.details;
    } catch {
      // keep default message
    }
    const err = new Error(msg);
    err.status = res.status;
    err.details = details;
    throw err;
  }
  return res.json();
}

/**
 * Persist the column mapping for an upload.
 */
export async function saveMapping(uploadId, mapping) {
  const res = await fetch(`${API_BASE}/uploads/${encodeURIComponent(uploadId)}/mapping`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping }),
  });
  if (!res.ok) {
    let msg = `Mapping save failed (${res.status})`;
    let details;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
      details = body && body.details;
    } catch {
      // keep default message
    }
    const err = new Error(msg);
    err.status = res.status;
    err.details = details;
    throw err;
  }
  return res.json();
}

/**
 * Execute the streaming ETL pipeline for an upload.
 */
export async function runPipeline(uploadId) {
  const res = await fetch(`${API_BASE}/uploads/${encodeURIComponent(uploadId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    let msg = `Pipeline run failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      // keep default message
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Upload a file via XHR so we get upload progress events.
 * onProgress receives a 0-100 percentage. The returned promise has an
 * .abort() method to cancel the in-flight request.
 */
export function uploadCsv(file, onProgress) {
  let xhrRef = null;
  const promise = new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/uploads`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error body
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body);
      } else {
        const err = new Error((body && body.error) || `Upload failed (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload aborted'));

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
    xhrRef = xhr;
  });

  promise.abort = () => {
    if (xhrRef) xhrRef.abort();
  };

  return promise;
}
