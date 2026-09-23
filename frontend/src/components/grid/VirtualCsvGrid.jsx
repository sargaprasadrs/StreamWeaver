import React from 'react';
import { FixedSizeList as List } from 'react-window';

/**
 * Virtualized CSV preview grid built on react-window.
 * Only visible rows are mounted in the DOM, so a 1,000-row preview
 * scrolls as smoothly as a 10-row table.
 */
export default function VirtualCsvGrid({ columns, rows, height = 420, truncated = false }) {
  if (!columns || columns.length === 0) {
    return <p className="grid-empty">No columns to display.</p>;
  }

  const ROW_HEIGHT = 32;
  const HEADER_HEIGHT = 36;
  const rowCount = rows ? rows.length : 0;
  const cellWidth = `${100 / columns.length}%`;

  function renderRow({ index, style }) {
    const row = rows[index];
    return (
      <div
        className={`grid-row${index % 2 === 1 ? ' grid-row--striped' : ''}`}
        style={style}
        role="row"
      >
        {columns.map((col, i) => {
          const value = row[i] === null || row[i] === undefined ? '' : String(row[i]);
          return (
            <div key={i} className="grid-cell" style={{ width: cellWidth }} title={value}>
              {value}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="grid-header" style={{ height: HEADER_HEIGHT }} role="row">
        {columns.map((col, i) => (
          <div key={i} className="grid-cell grid-cell--header" style={{ width: cellWidth }}>
            {col}
          </div>
        ))}
      </div>
      {rowCount === 0 ? (
        <p className="grid-empty">No data rows in this file.</p>
      ) : (
        <List
          height={height - HEADER_HEIGHT}
          width="100%"
          itemCount={rowCount}
          itemSize={ROW_HEIGHT}
          overscanCount={8}
        >
          {renderRow}
        </List>
      )}
      <p className="grid-note">
        Showing {rowCount} preview rows{truncated ? ' (limited to first 1,000)' : ''}
      </p>
    </div>
  );
}
