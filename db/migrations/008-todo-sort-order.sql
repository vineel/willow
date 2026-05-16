BEGIN;

ALTER TABLE app.todo
  ADD COLUMN sort_order double precision NOT NULL DEFAULT 0;

CREATE INDEX idx_todo_sort_order
  ON app.todo (sort_order DESC, created_at DESC)
  WHERE status = 'open';

COMMIT;
