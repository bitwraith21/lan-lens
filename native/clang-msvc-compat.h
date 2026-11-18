// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#if defined(__clang__) && defined(_MSC_VER) && defined(_M_X64)
// OBS's inline arithmetic header has a portable implementation. Clang's MSVC
// target does not provide the _udiv128 intrinsic used by the MSVC branch.
#include <stdint.h>
#pragma push_macro("_MSC_VER")
#undef _MSC_VER
#include <util/util_uint64.h>
#pragma pop_macro("_MSC_VER")
#endif
