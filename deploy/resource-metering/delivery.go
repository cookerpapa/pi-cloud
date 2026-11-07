// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package resourceusage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

var receiptHTTPClient = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (j *Journal) Deliver(ctx context.Context, endpoint, token string) error {
	rows, err := j.Batch(128)
	if err != nil || len(rows) == 0 {
		return err
	}
	events := make([]json.RawMessage, len(rows))
	for i, row := range rows {
		events[i] = row.Body
	}
	body, err := json.Marshal(struct {
		Events []json.RawMessage `json:"events"`
	}{events})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	// This is private infrastructure delivery, never a public model proxy route.

	response, err := receiptHTTPClient.Do(request)
	if err != nil {
		return errors.New("resource receiver unavailable")
	}
	defer response.Body.Close()
	var ack struct {
		Accepted int `json:"accepted"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&ack) != nil || ack.Accepted != len(rows) {
		return errors.New("resource batch not acknowledged")
	}
	return j.Acknowledge(rows)
}
