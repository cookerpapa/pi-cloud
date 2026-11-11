// Offline, operator-only retirement of buckets from removed Cube extensions.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"time"

	bolt "go.etcd.io/bbolt"
)

var obsolete = map[string]bool{
	"pi-cloud.allocations.v1": true, "pi-cloud.lifecycle.v1": true,
	"pi-cloud.resource-usage.v1": true, "volume_reference_state": true,
}

type Report struct {
	Removed      []string `json:"removed"`
	RetainedHash string   `json:"retainedHash"`
}

func field(h hash.Hash, v []byte) {
	_ = binary.Write(h, binary.BigEndian, uint64(len(v)))
	_, _ = h.Write(v)
}
func hashBucket(h hash.Hash, b *bolt.Bucket) error {
	_ = binary.Write(h, binary.BigEndian, b.Sequence())
	return b.ForEach(func(k, v []byte) error {
		field(h, k)
		if child := b.Bucket(k); child != nil {
			field(h, []byte("bucket"))
			return hashBucket(h, child)
		}
		field(h, []byte("value"))
		field(h, v)
		return nil
	})
}
func retainedHash(tx *bolt.Tx) (string, error) {
	h := sha256.New()
	err := tx.ForEach(func(k []byte, b *bolt.Bucket) error {
		if obsolete[string(k)] {
			return nil
		}
		field(h, k)
		return hashBucket(h, b)
	})
	return hex.EncodeToString(h.Sum(nil)), err
}
func prune(tx *bolt.Tx) (Report, error) {
	r := Report{Removed: []string{}}
	// A database without the native bucket is not the reviewed Cubelet metadata.
	if tx.Bucket([]byte("volume_refcounts")) == nil {
		return r, errors.New("native volume_refcounts bucket missing")
	}
	before, err := retainedHash(tx)
	if err != nil {
		return r, err
	}
	for _, name := range []string{"pi-cloud.allocations.v1", "pi-cloud.lifecycle.v1", "pi-cloud.resource-usage.v1", "volume_reference_state"} {
		if tx.Bucket([]byte(name)) != nil {
			if err := tx.DeleteBucket([]byte(name)); err != nil {
				return r, err
			}
			r.Removed = append(r.Removed, name)
		}
	}
	after, err := retainedHash(tx)
	if err != nil {
		return r, err
	}
	if before != after {
		return r, errors.New("native metadata changed")
	}
	r.RetainedHash = after
	return r, nil
}
func cleanup(path string) (Report, error) {
	var report Report
	info, err := os.Lstat(path)
	if err != nil {
		return report, err
	}
	if !info.Mode().IsRegular() {
		return report, errors.New("not a regular metadata file")
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return report, err
	}
	defer db.Close()
	err = db.Update(func(tx *bolt.Tx) error { var e error; report, e = prune(tx); return e })
	return report, err
}
func main() {
	if len(os.Args) != 3 || os.Args[1] != "--cold-prune" || filepath.Clean(os.Args[2]) != "/data/cubelet/state/io.containerd.metadata.v1.bolt/meta.db" {
		fmt.Fprintln(os.Stderr, "operator only: --cold-prune /data/cubelet/state/io.containerd.metadata.v1.bolt/meta.db")
		os.Exit(2)
	}
	r, err := cleanup(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(r)
}
