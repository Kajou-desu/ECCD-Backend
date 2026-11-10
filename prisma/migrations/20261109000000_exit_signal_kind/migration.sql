-- A face seen by the EXIT camera (automatic pickup). "face" stays the entry
-- camera's. Kept as its own migration: an enum value cannot be used in the
-- transaction that adds it.
ALTER TYPE "SignalKind" ADD VALUE 'exit';
