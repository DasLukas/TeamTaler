package httpapi

import (
	"io"
	"net/http"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
)

type requestLogResponseWriter struct {
	http.ResponseWriter
	status int
}

// requestContext assigns a request identifier and records one structured
// access-log event, including the final response status, after the response
// completes. Request and response bodies are never logged.
func (s *Server) requestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestID, _ := platform.NewID("req")
		response.Header().Set("X-Request-ID", requestID)
		loggedResponse := &requestLogResponseWriter{ResponseWriter: response}
		started := time.Now()

		next.ServeHTTP(loggedResponse, request)

		s.logger.Info(
			"http request",
			"method", request.Method,
			"path", request.URL.Path,
			"status", loggedResponse.statusCode(),
			"request_id", requestID,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func (w *requestLogResponseWriter) WriteHeader(status int) {
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestLogResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *requestLogResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(reader)
	}
	return io.Copy(w.ResponseWriter, reader)
}

// Unwrap lets http.ResponseController retain optional capabilities exposed by
// the underlying response writer, including streaming write deadlines.
func (w *requestLogResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *requestLogResponseWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}
