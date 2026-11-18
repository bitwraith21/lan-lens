package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole              = windows.NewLazySystemDLL("ole32.dll")
	shell            = windows.NewLazySystemDLL("shell32.dll")
	coInitialize     = ole.NewProc("CoInitializeEx")
	coUninitialize   = ole.NewProc("CoUninitialize")
	coCreate         = ole.NewProc("CoCreateInstance")
	coFree           = ole.NewProc("CoTaskMemFree")
	parsePath        = shell.NewProc("SHParseDisplayName")
	selectInExplorer = shell.NewProc("SHOpenFolderAndSelectItems")
)

type comObject struct{ vtable *[32]uintptr }
type filterSpec struct{ name, pattern *uint16 }

//go:uintptrescapes
func (c *comObject) call(index int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(c.vtable[index], append([]uintptr{uintptr(unsafe.Pointer(c))}, args...)...)
	return r
}
func utf16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

func apartment() (func(), error) {
	runtime.LockOSThread()
	hr, _, _ := coInitialize.Call(0, 6) // apartment threaded and OLE1 DDE disabled
	if int32(hr) < 0 {
		runtime.UnlockOSThread()
		return nil, hresult("Initialize file picker", hr)
	}
	return func() { coUninitialize.Call(); runtime.UnlockOSThread() }, nil
}
func hresult(action string, hr uintptr) error {
	if int32(hr) >= 0 {
		return nil
	}
	if uint32(hr) == 0x800704c7 {
		return errPickerCanceled
	}
	return fmt.Errorf("%s (0x%08x)", action, uint32(hr))
}

func chooseFile(export bool, title, suggested, extension string) (string, error) {
	done, err := apartment()
	if err != nil {
		return "", err
	}
	defer done()
	classText := "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}"
	interfaceText := "{d57c7288-d4ad-4768-be02-9d969532d960}"
	options := uintptr(0x40 | 0x800 | 0x1000) // filesystem paths and an existing file
	if export {
		classText = "{C0B4E2F3-BA21-4773-8DBA-335EC946EB8B}"
		interfaceText = "{84bccd23-5fde-4cdb-aea4-af64b83d78ab}"
		options = 0x2 | 0x40 | 0x800 // overwrite prompt, filesystem paths and existing parent
	}
	class, _ := windows.GUIDFromString(classText)
	iid, _ := windows.GUIDFromString(interfaceText)
	var dialog *comObject
	hr, _, _ := coCreate.Call(uintptr(unsafe.Pointer(&class)), 0, 1, uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&dialog)))
	if err = hresult("Open file picker", hr); err != nil {
		return "", err
	}
	defer dialog.call(2)
	pattern := "*." + extension
	spec := filterSpec{utf16(title + " (" + pattern + ")"), utf16(pattern)}
	titleText, ext := utf16(title), utf16(extension)
	dialog.call(4, 1, uintptr(unsafe.Pointer(&spec)))
	dialog.call(9, options)
	dialog.call(17, uintptr(unsafe.Pointer(titleText)))
	dialog.call(22, uintptr(unsafe.Pointer(ext)))
	if export {
		filename := utf16(suggested)
		dialog.call(15, uintptr(unsafe.Pointer(filename)))
		runtime.KeepAlive(filename)
	}
	hr = dialog.call(3, 0)
	runtime.KeepAlive(spec)
	runtime.KeepAlive(titleText)
	runtime.KeepAlive(ext)
	if err = hresult("Choose a file", hr); err != nil {
		return "", err
	}

	var item *comObject
	if err = hresult("Read selected file", dialog.call(20, uintptr(unsafe.Pointer(&item)))); err != nil {
		return "", err
	}
	defer item.call(2)
	var path *uint16
	if err = hresult("Read file path", item.call(5, 0x80058000, uintptr(unsafe.Pointer(&path)))); err != nil {
		return "", err
	}
	defer coFree.Call(uintptr(unsafe.Pointer(path)))
	return windows.UTF16PtrToString(path), nil
}

func reveal(path string) error {
	done, err := apartment()
	if err != nil {
		return err
	}
	defer done()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	var item uintptr
	hr, _, _ := parsePath.Call(uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&item)), 0, 0)
	if err = hresult("Locate exported file", hr); err != nil {
		return err
	}
	defer coFree.Call(item)
	hr, _, _ = selectInExplorer.Call(item, 0, 0, 0)
	return hresult("Show exported file in Explorer", hr)
}
