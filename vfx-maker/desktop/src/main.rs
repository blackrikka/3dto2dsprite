// 릴리스 빌드의 Windows 에서는 콘솔 창을 띄우지 않는다.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::PathBuf;

use rust_embed::RustEmbed;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::{Icon, WindowBuilder},
};
use wry::{
    http::{header::CONTENT_TYPE, Response},
    WebContext, WebViewBuilder,
};

/// `npm run build` 로 만든 웹 앱(dist/)을 실행 파일 안에 통째로 넣는다.
#[derive(RustEmbed)]
#[folder = "../dist/"]
struct Assets;

fn response(status: u16, mime: &str, body: Cow<'static, [u8]>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap()
}

/// WebView2 의 사용자 데이터 폴더 (실행 파일 옆이 읽기 전용이어도 동작하도록 별도 위치 사용)
fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)?;
    Some(base.join("vfxmaker"))
}

/// 32x32 RGBA 원시 데이터 (vfx-maker/desktop/make-icon.py 로 생성)
fn window_icon() -> Option<Icon> {
    Icon::from_rgba(include_bytes!("../icon/icon32.rgba").to_vec(), 32, 32).ok()
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_window_icon(window_icon())
        .with_title("VFX 메이커")
        .with_inner_size(LogicalSize::new(1500.0, 900.0))
        .with_min_inner_size(LogicalSize::new(900.0, 600.0))
        .build(&event_loop)
        .expect("창을 만들 수 없습니다");

    let mut context = WebContext::new(data_dir());

    let builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_devtools(cfg!(debug_assertions))
        .with_custom_protocol("app".into(), |_id, request| {
            let mut path = request.uri().path().trim_start_matches('/').to_string();
            if path.is_empty() {
                path = "index.html".into();
            }
            match Assets::get(&path) {
                Some(file) => {
                    let mime = mime_guess::from_path(&path).first_or_octet_stream();
                    response(200, mime.as_ref(), file.data)
                }
                None => response(404, "text/plain", Cow::Borrowed(b"not found")),
            }
        })
        // 내보내기(PNG/JSON/GIF)는 blob 다운로드로 처리된다 → 대화상자 없이 다운로드 폴더에 저장
        .with_download_started_handler(|_url, _path| true)
        .with_url("app://localhost/index.html");

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _webview = builder.build(&window)?;
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("GTK vbox 를 찾을 수 없습니다");
        builder.build_gtk(vbox)?
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    });
}
