package main

import (
	"errors"
	"os/exec"

	"github.com/ncruces/zenity"
)

func chooseFile(export bool, title, filename, extension string) (string, error) {
	opts := []zenity.Option{zenity.FileFilters{{Name: title, Patterns: []string{"*." + extension}}}}
	var path string
	var err error
	if export {
		path, err = zenity.SelectFileSave(append(opts, zenity.Title(title),
			zenity.Filename(filename), zenity.ConfirmOverwrite())...)
	} else {
		path, err = zenity.SelectFile(append(opts, zenity.Title(title))...)
	}
	if errors.Is(err, zenity.ErrCanceled) {
		return "", errPickerCanceled
	}
	return path, err
}

func reveal(path string) error { return exec.Command("/usr/bin/open", "-R", path).Run() }
