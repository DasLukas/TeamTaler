package main

import (
	"bytes"
	"os"
	"testing"
)

func TestReadBootstrapPasswordFromNonTerminal(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "bootstrap-stdin-*")
	if err != nil {
		t.Fatalf("create input: %v", err)
	}
	defer input.Close()
	if _, err := input.WriteString("pipe-safe-password-long\nignored\n"); err != nil {
		t.Fatalf("write input: %v", err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatalf("rewind input: %v", err)
	}
	var output bytes.Buffer
	password, err := readBootstrapPassword(input, &output)
	if err != nil {
		t.Fatalf("readBootstrapPassword: %v", err)
	}
	if password != "pipe-safe-password-long" {
		t.Fatalf("password = %q", password)
	}
	if output.Len() != 0 {
		t.Fatalf("non-terminal prompt output = %q", output.String())
	}
}
