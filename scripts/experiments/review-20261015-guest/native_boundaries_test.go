package execution

import (
	"context"
	"encoding/json"
	"errors"
	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/cio"
	"github.com/opencontainers/runtime-spec/specs-go"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type reviewIO struct{}

func (reviewIO) Config() cio.Config { return cio.Config{} }
func (reviewIO) Cancel()            {}
func (reviewIO) Wait()              {}
func (reviewIO) Close() error       { return nil }

type reviewProcess struct {
	containerd.Process
	start func(context.Context) error
	kill  func(context.Context) error
	exits <-chan containerd.ExitStatus
}

func (p reviewProcess) Start(ctx context.Context) error {
	if p.start != nil {
		return p.start(ctx)
	}
	return nil
}
func (p reviewProcess) Kill(ctx context.Context, _ syscall.Signal, _ ...containerd.KillOpts) error {
	if p.kill != nil {
		return p.kill(ctx)
	}
	return nil
}
func (p reviewProcess) Wait(context.Context) (<-chan containerd.ExitStatus, error) {
	return p.exits, nil
}
func (p reviewProcess) Delete(context.Context, ...containerd.ProcessDeleteOpts) (*containerd.ExitStatus, error) {
	return containerd.NewExitStatus(0, time.Now(), nil), nil
}
func (p reviewProcess) IO() cio.IO { return reviewIO{} }

type reviewTask struct {
	containerd.Task
	spec func(context.Context) (*specs.Spec, error)
	exec func(string) (containerd.Process, error)
}

func (t reviewTask) Spec(ctx context.Context) (*specs.Spec, error) {
	if t.spec != nil {
		return t.spec(ctx)
	}
	return &specs.Spec{Process: &specs.Process{}}, nil
}
func (t reviewTask) Exec(_ context.Context, id string, _ *specs.Process, _ cio.Creator) (containerd.Process, error) {
	return t.exec(id)
}

func TestReviewCleanupKillLosesDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	entered := make(chan bool, 1)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	task := reviewTask{exec: func(string) (containerd.Process, error) {
		return reviewProcess{
			exits: make(chan containerd.ExitStatus),
			kill: func(killContext context.Context) error {
				_, deadline := killContext.Deadline()
				entered <- deadline
				<-release
				return nil
			},
		}, nil
	}}
	driver := &ContainerdDriver{}
	operationID := request().OperationID
	done := make(chan error, 1)
	go func() { done <- driver.stopGroup(ctx, task, specs.Process{}, operationID) }()
	select {
	case hasDeadline := <-entered:
		if hasDeadline {
			t.Fatal("hypothesis not reproduced: Kill retained a deadline")
		}
	case <-time.After(time.Second):
		t.Fatal("cleanup never reached Kill")
	}
	select {
	case <-done:
		t.Fatal("cleanup unexpectedly returned while native Kill is stalled")
	case <-time.After(80 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("unexpected cleanup result %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("fixture did not settle")
	}
	t.Log(`MEASUREMENT {"case":"cleanup-kill-deadline","killHasDeadline":false,"returnedWhileKillStalled":false,"parentDeadlineMs":20,"observedAfterDeadlineMs":80}`)
}

func TestReviewExpiredSetupStillStartsLauncher(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := 0
	validStartContext := false
	task := reviewTask{
		spec: func(context.Context) (*specs.Spec, error) {
			<-parent.Done()
			return &specs.Spec{Process: &specs.Process{}}, nil
		},
		exec: func(id string) (containerd.Process, error) {
			exits := make(chan containerd.ExitStatus, 1)
			exits <- *containerd.NewExitStatus(1, time.Now(), nil)
			return reviewProcess{exits: exits, start: func(ctx context.Context) error {
				if strings.HasPrefix(id, "pc-") {
					started++
					validStartContext = ctx.Err() == nil
					if parent.Err() == nil {
						t.Error("fixture parent did not expire")
					}
				}
				return nil
			}}, nil
		},
	}
	driver := &ContainerdDriver{Resolve: func(context.Context, Request) (ResolvedTask, error) {
		return ResolvedTask{Task: task, Namespace: "review"}, nil
	}}
	r := request()
	r.Timeout = time.Second
	_ = driver.Run(parent, r, func(json.RawMessage) {})
	if started != 1 || !validStartContext {
		t.Fatalf("hypothesis not reproduced: starts=%d validContext=%v", started, validStartContext)
	}
	t.Log(`MEASUREMENT {"case":"expired-setup-start","launcherStarts":1,"startContextAlreadyCancelled":false,"parentAlreadyExpired":true,"userCommandExecutionNotClaimed":true}`)
}
