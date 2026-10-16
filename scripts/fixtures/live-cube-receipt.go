// Operator-only fault fixture. Build inside the exact patched Cubelet module.
// The production driver and guest remain unchanged; only one stdin receipt is
// filtered between their real native FIFOs. Run only for an owned disposable VM.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/cio"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/fifo"
	"github.com/google/uuid"
	"github.com/opencontainers/runtime-spec/specs-go"
	"github.com/tencentcloud/CubeSandbox/Cubelet/pkg/execution"
)

type filteredIO struct {
	cio.IO
	config cio.Config
	stop   func()
}

func (f *filteredIO) Config() cio.Config { return f.config }
func (f *filteredIO) Cancel()            { f.stop(); f.IO.Cancel() }
func (f *filteredIO) Close() error       { f.stop(); return f.IO.Close() }

type filteredTask struct {
	containerd.Task
	dropID   string
	dropped  atomic.Int32
	cleanups atomic.Int32
}

func (t *filteredTask) Exec(ctx context.Context, id string, spec *specs.Process, creator cio.Creator) (containerd.Process, error) {
	if strings.HasPrefix(id, "ps-") {
		t.cleanups.Add(1)
	}
	if id != "pc-"+t.dropID {
		return t.Task.Exec(ctx, id, spec, creator)
	}
	return t.Task.Exec(ctx, id, spec, func(id string) (cio.IO, error) {
		original, err := creator(id)
		if err != nil {
			return nil, err
		}
		config := original.Config()
		input := config.Stdin
		config.Stdin += "-receipt-filter"
		if err := syscall.Mkfifo(config.Stdin, 0600); err != nil {
			original.Cancel()
			_ = original.Close()
			return nil, err
		}
		lifetime, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		var once sync.Once
		stop := func() { once.Do(func() { cancel(); _ = os.Remove(config.Stdin) }) }
		go func() {
			from, err := fifo.OpenFifo(lifetime, input, os.O_RDONLY, 0)
			if err != nil {
				return
			}
			defer from.Close()
			to, err := fifo.OpenFifo(lifetime, config.Stdin, os.O_WRONLY, 0)
			if err != nil {
				return
			}
			defer to.Close()
			go func() { <-lifetime.Done(); _ = from.Close(); _ = to.Close() }()
			reader := bufio.NewReader(from)
			for {
				line, err := reader.ReadString('\n')
				if strings.TrimSpace(line) == `{"type":"scope.received"}` {
					t.dropped.Add(1)
				} else if line != "" {
					if _, writeErr := io.WriteString(to, line); writeErr != nil {
						return
					}
				}
				if err != nil {
					// Keep the guest side open so this exercises receipt timeout,
					// rather than delivering an immediate EOF to its launcher.
					if t.dropped.Load() > 0 {
						<-lifetime.Done()
					}
					return
				}
			}
		}()
		return &filteredIO{IO: original, config: config, stop: stop}, nil
	})
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

func run() (map[string]interface{}, error) {
	if len(os.Args) != 3 || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(os.Args[2]) {
		return nil, errors.New("provide native socket and exact owned sandbox ID")
	}
	client, err := containerd.New(os.Args[1])
	if err != nil {
		return nil, err
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	spaces, err := client.NamespaceService().List(ctx)
	if err != nil {
		return nil, err
	}
	var task containerd.Task
	var namespace string
	for _, space := range spaces {
		local := namespaces.WithNamespace(ctx, space)
		container, e := client.LoadContainer(local, os.Args[2])
		if e != nil {
			continue
		}
		candidate, e := container.Task(local, nil)
		if e != nil {
			return nil, e
		}
		if task != nil {
			return nil, errors.New("ambiguous native sandbox identity")
		}
		task, namespace = candidate, space
	}
	if task == nil {
		return nil, errors.New("owned sandbox native task is absent")
	}
	if err := os.MkdirAll("/data/cubelet/fifo", 0755); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp("/data/cubelet/fifo", "pi-cloud-receipt-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	wrapped := &filteredTask{Task: task}
	driver := &execution.ContainerdDriver{FIFODirectory: directory, Resolve: func(context.Context, execution.Request) (execution.ResolvedTask, error) {
		return execution.ResolvedTask{Task: wrapped, Namespace: namespace}, nil
	}}
	prefix := filepath.Join("/workspace", ".receipt-"+uuid.NewString())
	activation := uuid.NewString()
	execute := func(command string, drop bool) (string, error) {
		operation := uuid.NewString()
		if drop {
			wrapped.dropID = operation
		}
		payload, _ := json.Marshal(map[string]interface{}{
			"toolWorkerProtocolVersion": 7, "type": "worker.operation",
			"attachment": map[string]interface{}{"activationId": activation, "toolRoot": "/workspace"},
			"request":    map[string]interface{}{"toolBrokerProtocolVersion": 1, "type": "tool_sandbox.operation", "operation": "tool.execute", "activationId": activation, "operationId": operation, "toolCallId": "receipt-fixture", "toolName": "bash", "args": map[string]string{"command": command}, "timeoutMs": 10000, "maximumOutputBytes": 51200},
		})
		request := execution.Request{SandboxID: os.Args[2], OperationID: operation, RunID: uuid.NewString(), WriterID: uuid.NewString(), Payload: payload, Timeout: 15 * time.Second, MaximumOutputBytes: 8 * 1024 * 1024}
		executionContext, end := context.WithTimeout(ctx, request.Timeout)
		defer end()
		result := driver.Run(executionContext, request, func(json.RawMessage) {})
		if result.Failure != "" || result.Quarantine {
			return "", fmt.Errorf("native result failed: %s quarantine=%t", result.Failure, result.Quarantine)
		}
		var value struct {
			Response struct {
				Event struct {
					IsError bool `json:"isError"`
					Result  struct {
						Content []struct {
							Text string `json:"text"`
						} `json:"content"`
					} `json:"result"`
				} `json:"event"`
			} `json:"response"`
		}
		if err := json.Unmarshal(result.Output, &value); err != nil {
			return "", err
		}
		if value.Response.Event.IsError {
			return "", errors.New("guest fixture command failed")
		}
		var text strings.Builder
		for _, part := range value.Response.Event.Result.Content {
			text.WriteString(part.Text)
		}
		return text.String(), nil
	}
	if _, err := execute("nohup sleep 120 </dev/null >/dev/null 2>&1 & echo $! > "+quote(prefix+".sibling"), false); err != nil {
		return nil, err
	}
	server := fmt.Sprintf("from http.server import HTTPServer,SimpleHTTPRequestHandler;from pathlib import Path;s=HTTPServer(('127.0.0.1',0),SimpleHTTPRequestHandler);Path(%q).write_text(str(s.server_port));s.serve_forever()", prefix+".port")
	started := time.Now()
	result, err := execute("nohup python3 -u -c "+quote(server)+" </dev/null >"+quote(prefix+".log")+" 2>&1 & echo $! > "+quote(prefix+".pid")+"; printf RECEIPT_READY", true)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(result, "RECEIPT_READY") || wrapped.dropped.Load() != 1 || wrapped.cleanups.Load() != 0 {
		return nil, errors.New("receipt fault did not preserve the completed result")
	}
	verification := fmt.Sprintf("import pathlib,urllib.request;port=int(pathlib.Path(%q).read_text());assert urllib.request.urlopen('http://127.0.0.1:'+str(port),timeout=3).status==200;print('BACKGROUND_PRESERVED')", prefix+".port")
	verified, err := execute("kill -0 \"$(cat "+quote(prefix+".pid")+")\" && kill -0 \"$(cat "+quote(prefix+".sibling")+")\" && python3 -c "+quote(verification), false)
	if err != nil || !strings.Contains(verified, "BACKGROUND_PRESERVED") {
		return nil, errors.New("background or sibling process did not survive receipt loss")
	}
	return map[string]interface{}{"accepted": true, "droppedReceipts": wrapped.dropped.Load(), "scopeCleanupCalls": wrapped.cleanups.Load(), "backgroundServerAlive": true, "siblingAlive": true, "resultRetained": true, "elapsedMs": time.Since(started).Milliseconds()}, nil
}

func main() {
	report, err := run()
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"accepted": false, "failure": err.Error()})
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(report)
}
