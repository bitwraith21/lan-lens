// SPDX-License-Identifier: GPL-2.0-or-later
#include <sys/stat.h>
#include <obs-frontend-api.h>
#include <panel/browser-panel.hpp>

#include <QDockWidget>
#include <QLabel>
#include <QPointer>
#include <QPushButton>
#include <QTimer>
#include <QVBoxLayout>

#include <memory>
#include <string>

#include "dock.h"
extern "C" {
#include "process.h"
}

namespace {
constexpr auto dock_id = "lan-lens-dashboard";

class Dashboard final : public QWidget {
public:
	Dashboard()
	{
		layout = new QVBoxLayout(this);
		layout->setContentsMargins(0, 0, 0, 0);
		layout->setSpacing(0);
		external = new QPushButton(tr("Open in Browser"), this);
		external->setEnabled(false);
		layout->addWidget(external);
		message = new QLabel(tr("Starting the local camera server…"), this);
		message->setAlignment(Qt::AlignCenter);
		message->setWordWrap(true);
		layout->addWidget(message, 1);
		setMinimumWidth(260);
		connect(external, &QPushButton::clicked, this, [this] {
			if (!url.empty() && !open_dashboard(url.c_str()))
				blog(LOG_WARNING, "[LAN Lens] Could not open the system browser.");
		});
	}

	~Dashboard() override { delete browser; }

	void setUrl(const char *next)
	{
		url = next ? next : "";
		external->setEnabled(!url.empty());
		if (url.empty()) {
			delete browser;
			browser = nullptr;
			message->setText(tr("Camera server unavailable. See the OBS log for details."));
			message->show();
			return;
		}
		if (browser) {
			browser->setURL(embeddedUrl());
			return;
		}
		if (!cef)
			cef.reset(obs_browser_init_panel());
		if (!cef) {
			message->setText(tr("OBS Browser Source could not open the dock."));
			blog(LOG_WARNING, "[LAN Lens] OBS Browser panel API unavailable.");
			return;
		}
		cef->init_browser();
		createBrowser();
	}

private:
	std::string embeddedUrl() const
	{
		std::string embedded = url;
		embedded.insert(embedded.find('#'), "?dock=1");
		return embedded;
	}

	void createBrowser(int attempts = 0)
	{
		if (url.empty() || browser)
			return;
		if (!cef->initialized()) {
			if (attempts < 150) {
				QTimer::singleShot(100, this, [this, attempts] { createBrowser(attempts + 1); });
			} else {
				message->setText(tr("OBS Browser Source did not finish loading."));
				blog(LOG_WARNING, "[LAN Lens] Timed out waiting for the OBS Browser panel.");
			}
			return;
		}

		browser = cef->create_widget(this, embeddedUrl());
		if (!browser) {
			message->setText(tr("OBS Browser Source could not open the dock."));
			return;
		}
		browser->allowAllPopups(true);
		layout->addWidget(browser, 1);
		message->hide();
		blog(LOG_INFO, "[LAN Lens] Dashboard loaded in the OBS dock.");
	}

	QVBoxLayout *layout = nullptr;
	QPushButton *external = nullptr;
	QLabel *message = nullptr;
	std::unique_ptr<QCef> cef;
	QCefWidget *browser = nullptr;
	std::string url;
};

QPointer<Dashboard> dashboard;
}

void register_dashboard_dock()
{
	if (dashboard)
		return;
	auto *content = new Dashboard;
	if (!obs_frontend_add_dock_by_id(dock_id, "LAN Lens for OBS", content)) {
		delete content;
		blog(LOG_WARNING, "[LAN Lens] The OBS dock could not be registered.");
		return;
	}

	dashboard = content;
	blog(LOG_INFO, "[LAN Lens] Registered the LAN Lens dock.");
}

void show_dashboard_dock(bool attach)
{
	if (dashboard) {
		if (auto *dock = qobject_cast<QDockWidget *>(dashboard->parentWidget())) {
			if (attach)
				dock->setFloating(false);
			dock->show();
			dock->raise();
			dock->activateWindow();
		}
	}
}

void set_dashboard_url(const char *url)
{
	if (dashboard)
		dashboard->setUrl(url);
}

void destroy_dashboard_dock()
{
	if (!dashboard)
		return;
	dashboard->setUrl(nullptr);
	obs_frontend_remove_dock(dock_id);
	dashboard.clear();
}
