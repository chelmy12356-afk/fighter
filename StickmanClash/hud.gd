extends Control
## Code-drawn HUD: health bars, timer, round dots, menu and online screens.

const GOLD := Color(1, 0.85, 0.4)
const SOFT := Color(0.88, 0.9, 0.95)
const DIM := Color(0.55, 0.58, 0.68)

const P1_KEYS := "A/D MOVE   SPACE JUMP   W UPPERCUT   S BLOCK   F or LEFT CLICK PUNCH   G or RIGHT CLICK KICK"
const P2_KEYS := "ARROWS MOVE   UP JUMP   I UPPERCUT   DOWN BLOCK   K PUNCH   L KICK"

var main = null
var p1_name := "PLAYER 1"
var p2_name := "PLAYER 2"
var p1_health := 100.0
var p2_health := 100.0
var disp1 := 100.0
var disp2 := 100.0
var p1_wins := 0
var p2_wins := 0
var time_left := 60
var round_num := 1


func _process(delta: float) -> void:
	disp1 = move_toward(disp1, p1_health, 60.0 * delta)
	disp2 = move_toward(disp2, p2_health, 60.0 * delta)
	queue_redraw()


func _center(font: Font, y: float, text: String, size: int, col: Color) -> void:
	draw_string(font, Vector2(0, y), text, HORIZONTAL_ALIGNMENT_CENTER, 1280, size, col)


func _draw() -> void:
	var font: Font = ThemeDB.fallback_font
	if main == null:
		return
	var st: int = main.state
	if st == main.GState.MENU:
		_draw_menu(font)
		return
	if st == main.GState.HOST_WAIT:
		_draw_host(font)
		return
	if st == main.GState.JOIN_TYPE or st == main.GState.JOIN_WAIT:
		_draw_join(font, st == main.GState.JOIN_WAIT)
		return
	_draw_bars(font)
	if st == main.GState.MATCH_END:
		var msg := "PRESS  R  FOR MENU"
		if main.net_mode == main.Net.HOST:
			msg = "PRESS  R  FOR A REMATCH      ESC  TO LEAVE"
		elif main.net_mode == main.Net.CLIENT:
			msg = "WAITING FOR THE HOST TO START A REMATCH      ESC  TO LEAVE"
		_center(font, 690, msg, 22, GOLD)


func _draw_bars(font: Font) -> void:
	var y: float = 36.0
	var w: float = 520.0
	var h: float = 26.0
	var f1: float = clampf(p1_health / 100.0, 0.0, 1.0)
	var f2: float = clampf(p2_health / 100.0, 0.0, 1.0)
	var d1: float = clampf(disp1 / 100.0, 0.0, 1.0)
	var d2: float = clampf(disp2 / 100.0, 0.0, 1.0)
	draw_rect(Rect2(42, y, w, h), Color(0, 0, 0, 0.6))
	draw_rect(Rect2(1238 - w, y, w, h), Color(0, 0, 0, 0.6))
	draw_rect(Rect2(42, y, w * d1, h), Color(1, 1, 1, 0.5))
	draw_rect(Rect2(1238 - w * d2, y, w * d2, h), Color(1, 1, 1, 0.5))
	var c1: Color = Color(1.0, 0.35, 0.32)
	var c2: Color = Color(0.36, 0.6, 1.0)
	if p1_health <= 30.0:
		c1 = Color(0.98, 0.62, 0.18)
	if p2_health <= 30.0:
		c2 = Color(0.98, 0.62, 0.18)
	draw_rect(Rect2(42, y, w * f1, h), c1)
	draw_rect(Rect2(1238 - w * f2, y, w * f2, h), c2)
	draw_rect(Rect2(42, y, w, h), Color(0, 0, 0, 0.9), false, 2.0)
	draw_rect(Rect2(1238 - w, y, w, h), Color(0, 0, 0, 0.9), false, 2.0)
	var n1: String = p1_name
	var n2: String = p2_name
	if main.net_mode == main.Net.HOST:
		n1 += "  (YOU)"
	elif main.net_mode == main.Net.CLIENT:
		n2 = "(YOU)  " + n2
	draw_string(font, Vector2(46, y + 54), n1, HORIZONTAL_ALIGNMENT_LEFT, 400, 22, Color(0.95, 0.95, 1))
	draw_string(font, Vector2(1234 - 400, y + 54), n2, HORIZONTAL_ALIGNMENT_RIGHT, 400, 22, Color(0.95, 0.95, 1))
	var tc: Color = Color(1, 1, 1)
	if time_left <= 10:
		tc = Color(1, 0.35, 0.3)
	draw_string(font, Vector2(592, 96), str(time_left), HORIZONTAL_ALIGNMENT_CENTER, 96, 52, tc)
	draw_string(font, Vector2(592, 118), "ROUND " + str(round_num), HORIZONTAL_ALIGNMENT_CENTER, 96, 17, Color(0.65, 0.68, 0.8))
	for i in 2:
		var c1p: Vector2 = Vector2(566 - 16 - i * 24, 82)
		if p1_wins > i:
			draw_circle(c1p, 7, Color(1.0, 0.35, 0.32))
		else:
			draw_arc(c1p, 7, 0, TAU, 20, Color(0.45, 0.45, 0.55), 2)
		var c2p: Vector2 = Vector2(714 + 16 + i * 24, 82)
		if p2_wins > i:
			draw_circle(c2p, 7, Color(0.36, 0.6, 1.0))
		else:
			draw_arc(c2p, 7, 0, TAU, 20, Color(0.45, 0.45, 0.55), 2)
	var hint := Color(1, 1, 1, 0.35)
	if main.net_mode != main.Net.OFF or main.vs_cpu:
		_center(font, 700, P1_KEYS, 15, hint)
	else:
		_center(font, 682, "P1   " + P1_KEYS, 14, hint)
		_center(font, 702, "P2   " + P2_KEYS, 14, hint)


func _draw_menu(font: Font) -> void:
	_center(font, 170, "STICKMAN  CLASH", 84, Color(1, 1, 1))
	_center(font, 204, "1 v 1  stickman  fighting", 24, Color(0.7, 0.74, 0.88))
	if main.menu_msg != "":
		_center(font, 244, main.menu_msg, 20, Color(1, 0.45, 0.4))
	var blink: bool = int(Time.get_ticks_msec() / 500.0) % 2 == 0
	var oc: Color = GOLD if blink else Color(1, 0.85, 0.4, 0.55)
	_center(font, 292, "[1]  VS  CPU          [2]  TWO  PLAYERS,  ONE  KEYBOARD", 28, oc)
	_center(font, 334, "[3]  HOST  ONLINE  GAME          [4]  JOIN  ONLINE  GAME", 28, oc)
	var px: float = 210.0
	var py: float = 372.0
	draw_rect(Rect2(px, py, 860, 222), Color(0, 0, 0, 0.45))
	draw_rect(Rect2(px, py, 860, 222), Color(1, 1, 1, 0.12), false, 1)
	_center(font, py + 32, "PLAYER 1   (also your controls in an online game)", 20, Color(1, 0.55, 0.5))
	_center(font, py + 60, "A / D  move     SPACE  jump     W  uppercut     S  block     F or left click  punch     G or right click  kick", 17, SOFT)
	_center(font, py + 102, "PLAYER 2", 20, Color(0.55, 0.72, 1))
	_center(font, py + 130, "ARROWS  move     UP  jump     I  uppercut     DOWN  block     K  punch     L  kick", 17, SOFT)
	_center(font, py + 172, "first to 2 round wins  -  60s rounds  -  blocking cuts damage to 15%", 16, DIM)
	_center(font, py + 196, "the uppercut only hits an opponent who is in the air, and it beats jump attacks", 16, DIM)
	_center(font, 700, "ESC  quit", 15, Color(1, 1, 1, 0.35))


func _draw_host(font: Font) -> void:
	_center(font, 150, "HOSTING  ONLINE  GAME", 56, Color(1, 1, 1))
	var dots := ".".repeat(1 + int(Time.get_ticks_msec() / 400.0) % 3)
	_center(font, 200, "waiting for player 2 " + dots, 24, GOLD)
	draw_rect(Rect2(190, 240, 900, 300), Color(0, 0, 0, 0.5))
	draw_rect(Rect2(190, 240, 900, 300), Color(1, 1, 1, 0.12), false, 1)
	_center(font, 278, "FRIEND ON THE SAME WI-FI / NETWORK", 18, Color(0.55, 0.72, 1))
	var ips: Array = main.host_ips
	if ips.is_empty():
		_center(font, 322, "no network found", 30, SOFT)
	else:
		_center(font, 322, "  or  ".join(PackedStringArray(ips.slice(0, 3))), 34, Color(1, 1, 1))
	_center(font, 352, "they press [4] on the menu and type this address", 16, DIM)
	_center(font, 410, "FRIEND SOMEWHERE ELSE (OVER THE INTERNET)", 18, Color(1, 0.55, 0.5))
	_center(font, 448, main.upnp_status, 22, SOFT)
	_center(font, 480, "Relay tunnel: forward UDP " + str(main.NET_PORT) + " here; share its address:port", 16, DIM)
	_center(font, 514, "you will be PLAYER 1 (red)", 16, DIM)
	_center(font, 600, "ESC  to cancel", 20, GOLD)


func _draw_join(font: Font, connecting: bool) -> void:
	_center(font, 150, "JOIN  ONLINE  GAME", 56, Color(1, 1, 1))
	if connecting:
		var dots := ".".repeat(1 + int(Time.get_ticks_msec() / 400.0) % 3)
		_center(font, 330, "connecting to  " + main.join_ip + " " + dots, 30, GOLD)
		_center(font, 600, "ESC  to cancel", 20, GOLD)
		return
	_center(font, 230, "type the host address; relay addresses include :port, then press ENTER", 22, SOFT)
	draw_rect(Rect2(340, 280, 600, 76), Color(0, 0, 0, 0.55))
	draw_rect(Rect2(340, 280, 600, 76), GOLD, false, 2)
	var txt: String = main.join_ip
	if int(Time.get_ticks_msec() / 400.0) % 2 == 0:
		txt += "_"
	else:
		txt += " "
	_center(font, 334, txt, 40, Color(1, 1, 1))
	_center(font, 400, "examples:  192.168.1.23  or  relay.example:12345", 17, DIM)
	_center(font, 430, "CTRL + V  pastes        BACKSPACE  deletes        you will be PLAYER 2 (blue)", 17, DIM)
	_center(font, 600, "ENTER  to connect          ESC  to go back", 20, GOLD)
