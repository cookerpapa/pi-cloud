// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// The caller supplies the already-authorized directory and the SAME locked open
// file description at fd 3/4. Keeping both descriptors alive fences a late kernel
// exchange even when the Node receiver is terminated mid-operation.
func main() {
	if len(os.Args) != 2 || (os.Args[1] != "recovery-a" && os.Args[1] != "recovery-b") {
		os.Exit(2)
	}
	directory := os.NewFile(3, "upload-directory")
	lock := os.NewFile(4, "upload-lock")
	if directory == nil || lock == nil {
		os.Exit(2)
	}
	defer directory.Close()
	defer lock.Close()
	info, err := directory.Stat()
	if err != nil || !info.IsDir() {
		os.Exit(2)
	}
	info, err = lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != 0 {
		os.Exit(2)
	}
	if err = unix.Renameat2(3, "metadata", 3, os.Args[1], unix.RENAME_EXCHANGE); err != nil {
		fmt.Fprintln(os.Stderr, "upload_metadata_exchange_failed")
		os.Exit(1)
	}
}
