BEGIN;

ALTER TABLE app.todo
  DROP CONSTRAINT todo_source_check;

ALTER TABLE app.todo
  ADD CONSTRAINT todo_source_check
  CHECK (source IN ('email', 'conversation', 'agent', 'web'));

COMMIT;
