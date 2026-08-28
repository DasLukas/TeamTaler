package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/statistics"
)

func (s *Server) handleMemberStatistics(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	dashboard, err := s.statistics.Members(request.Context(), membership, statisticsQuery(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, dashboard)
}

func (s *Server) handleFinanceStatistics(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	dashboard, err := s.statistics.Finance(request.Context(), membership, statisticsQuery(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, dashboard)
}

func statisticsQuery(request *http.Request) statistics.Query {
	values := request.URL.Query()
	return statistics.Query{
		Preset: statistics.Preset(values.Get("range")),
		From:   values.Get("from"),
		To:     values.Get("to"),
	}
}
