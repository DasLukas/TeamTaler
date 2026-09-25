package tabular

import "github.com/go-pdf/fpdf"

// RegisterNotoSans installs the embedded regular and semibold Unicode fonts on
// pdf for other TeamTaler PDF layouts. It returns any fpdf registration error.
// Example: err := tabular.RegisterNotoSans(pdf).
func RegisterNotoSans(pdf *fpdf.Fpdf) error {
	pdf.AddUTF8FontFromBytes(regularFontFamily, "", notoSansRegular)
	pdf.AddUTF8FontFromBytes(regularFontFamily, "B", notoSansSemibold)
	return pdf.Error()
}
