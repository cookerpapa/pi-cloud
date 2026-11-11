package main

import (
	"errors"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "meta.db")
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"v1", "volume_refcounts", "unknown-native", "pi-cloud.lifecycle.v1", "volume_reference_state"} {
			b, e := tx.CreateBucket([]byte(name))
			if e != nil {
				return e
			}
			_ = b.SetSequence(42)
			_ = b.Put([]byte("key"), []byte("keep"))
			c, _ := b.CreateBucket([]byte("nested"))
			_ = c.Put([]byte("empty"), []byte{})
		}
		return nil
	})
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	return path
}
func TestPrunePreservesNativeAndRepeats(t *testing.T) {
	p := fixture(t)
	r, e := cleanup(p, "v1")
	if e != nil || len(r.Removed) != 1 {
		t.Fatalf("%+v %v", r, e)
	}
	again, e := cleanup(p, "v1")
	if e != nil || len(again.Removed) != 0 || again.RetainedHash != r.RetainedHash {
		t.Fatalf("%+v %v", again, e)
	}
}
func TestMissingAndLiveDatabase(t *testing.T) {
	p := filepath.Join(t.TempDir(), "missing")
	if _, e := cleanup(p, "v1"); e == nil {
		t.Fatal("created missing db")
	}
	if _, e := os.Stat(p); !os.IsNotExist(e) {
		t.Fatal(e)
	}
	p = fixture(t)
	db, _ := bolt.Open(p, 0600, nil)
	defer db.Close()
	if _, e := cleanup(p, "v1"); !errors.Is(e, bolt.ErrTimeout) {
		t.Fatal(e)
	}
}
func TestTransactionRollback(t *testing.T) {
	p := fixture(t)
	db, _ := bolt.Open(p, 0600, nil)
	defer db.Close()
	_ = db.Update(func(tx *bolt.Tx) error {
		if _, e := prune(tx, "v1"); e != nil {
			t.Fatal(e)
		}
		return errors.New("interruption")
	})
	_ = db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte("pi-cloud.lifecycle.v1")) == nil {
			t.Fatal("rolled-back deletion persisted")
		}
		return nil
	})
}
func TestWrongDatabase(t *testing.T) {
	p := filepath.Join(t.TempDir(), "meta.db")
	db, _ := bolt.Open(p, 0600, nil)
	db.Close()
	if _, e := cleanup(p, "v1"); e == nil {
		t.Fatal("wrong db accepted")
	}
}

func TestVolumeDatabaseSeparately(t *testing.T) {
	p := fixture(t)
	r, e := cleanup(p, "volume_refcounts")
	if e != nil || len(r.Removed) != 1 || r.Removed[0] != "volume_reference_state" {
		t.Fatalf("%+v %v", r, e)
	}
	db, _ := bolt.Open(p, 0600, nil)
	defer db.Close()
	_ = db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte("pi-cloud.lifecycle.v1")) == nil {
			t.Fatal("wrong database bucket removed")
		}
		return nil
	})
}
