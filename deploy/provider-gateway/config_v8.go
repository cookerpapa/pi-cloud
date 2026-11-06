// One-time operator conversion using the pinned provider's own configuration API.
// Installed as cmd/picloud-config in the provider build; never run by an Agent.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

const maximumConfigBytes = 1024 * 1024

func convertProviderConfig(raw []byte, check bool) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maximumConfigBytes {
		return nil, fmt.Errorf("invalid provider configuration size")
	}
	if check {
		if err := config.ValidateV8Config(raw); err != nil {
			return nil, err
		}
	} else {
		converted, _, err := config.NormalizeConfigLayout(raw, true)
		if err != nil {
			return nil, err
		}
		raw = converted
		// Match the native v8 management writer's YAML encoding so a publication
		// receipt can compare exact old/new file hashes after a lost PUT response.
		var document yaml.Node
		if err := yaml.Unmarshal(raw, &document); err != nil {
			return nil, err
		}
		config.NormalizeCollectionNodeStyles(document.Content[0])
		raw, err = yaml.Marshal(&document)
		if err != nil {
			return nil, err
		}
		raw = config.NormalizeCommentIndentation(raw)
	}
	if err := config.ValidateV8Config(raw); err != nil {
		return nil, err
	}
	if _, err := config.ParseConfigBytes(raw); err != nil {
		return nil, err
	}
	return bytes.Clone(raw), nil
}

func runProviderConfig(args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("pi-cloud-config", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	check := flags.Bool("check", false, "validate an already canonical v8 document")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return fmt.Errorf("invalid configuration command")
	}
	raw, err := io.ReadAll(io.LimitReader(input, maximumConfigBytes+1))
	if err != nil {
		return err
	}
	converted, err := convertProviderConfig(raw, *check)
	if err != nil {
		return err
	}
	if *check {
		_, err = fmt.Fprintln(output, "PROVIDER_CONFIG_OK")
	} else {
		_, err = output.Write(converted)
	}
	return err
}

func main() {
	// A configuration error must not echo operator-controlled secrets or values.
	log.SetOutput(io.Discard)
	if err := runProviderConfig(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "Provider configuration conversion or validation failed")
		os.Exit(1)
	}
}
