extends Node2D

## STICKMAN CLASH - 1v1 stickman fighting game.
## Graphics, sounds and UI are all generated from code. No assets needed.

const HUD = preload("res://hud.gd")

const GROUND_Y := 612.0
const ARENA_LEFT := 70.0
const ARENA_RIGHT := 1210.0
const ROUND_TIME := 60.0
const WINS_NEEDED := 2
const NET_PORT := 3000
const IP_FILE := "user://last_ip.txt"

enum GState { MENU, INTRO, FIGHT, ROUND_END, AWARD, MATCH_END, HOST_WAIT, JOIN_TYPE, JOIN_WAIT }
enum Net { OFF, HOST, CLIENT }

# Lowercase aliases so other scripts can read main.ground_y etc.
var ground_y := GROUND_Y
var arena_left := ARENA_LEFT
var arena_right := ARENA_RIGHT

var state: int = GState.MENU
var p1: Fighter
var p2: Fighter
var fighters: Array = []
var vs_cpu := true
var round_num := 1
var time_left := ROUND_TIME
var round_winner: Fighter = null
var round_end_delay := 0.0
var hud = null
var announce_label: Label
var ann_tween: Tween = null
var shake_time := 0.0
var slowmo_t := 0.0

# --- online play ---
var net_mode: int = Net.OFF
var net_live := false      # the other player is connected and a match is running
var net_peer_id := 0       # host only: id of the connected player
var join_ip := ""
var join_timer := 0.0
var host_ips: Array = []
var menu_msg := ""
var menu_msg_t := 0.0
var upnp_status := ""
var upnp: UPNP = null
var upnp_thread: Thread = null
var upnp_mapped := false
var _prev_bits := 0
var _latch := [0, 0, 0, 0]


func _ready() -> void:
	randomize()
	_make_sounds()
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = HUD.new()
	hud.main = self
	layer.add_child(hud)
	announce_label = Label.new()
	announce_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	announce_label.add_theme_font_size_override("font_size", 92)
	announce_label.add_theme_color_override("font_color", Color(1, 1, 1))
	announce_label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	announce_label.add_theme_constant_override("outline_size", 10)
	announce_label.modulate.a = 0.0
	layer.add_child(announce_label)
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)
	if FileAccess.file_exists(IP_FILE):
		var f := FileAccess.open(IP_FILE, FileAccess.READ)
		if f != null:
			join_ip = _clean_address(f.get_line())
	_make_fighters(true, true)


func _exit_tree() -> void:
	_net_stop()
	if upnp_thread != null:
		upnp_thread.wait_to_finish()
		upnp_thread = null


func _process(delta: float) -> void:
	if slowmo_t > 0.0:
		slowmo_t -= delta / max(Engine.time_scale, 0.05)
		if slowmo_t <= 0.0:
			slowmo_t = 0.0
			Engine.time_scale = 1.0

	if shake_time > 0.0:
		shake_time = max(0.0, shake_time - delta)
		var amp: float = 13.0 * clamp(shake_time / 0.25, 0.0, 1.0)
		position = Vector2(randf_range(-amp, amp), randf_range(-amp, amp))
		if shake_time <= 0.0:
			position = Vector2.ZERO
	elif position != Vector2.ZERO:
		position = Vector2.ZERO

	if menu_msg_t > 0.0:
		menu_msg_t -= delta
		if menu_msg_t <= 0.0:
			menu_msg = ""

	if p1 != null and p2 != null and hud != null:
		hud.p1_health = p1.health
		hud.p2_health = p2.health

	if state == GState.JOIN_WAIT:
		join_timer -= delta
		if join_timer <= 0.0:
			_net_drop("COULD NOT CONNECT - CHECK THE ADDRESS")
		return

	# online client: the host runs the match, we only display it
	if net_mode == Net.CLIENT:
		return

	match state:
		GState.FIGHT:
			time_left -= delta
			hud.time_left = max(0, int(ceil(time_left)))
			if time_left <= 0.0:
				_time_up()
		GState.ROUND_END:
			round_end_delay -= delta
			if round_end_delay <= 0.0:
				state = GState.AWARD
				_end_round()


func _physics_process(_delta: float) -> void:
	if not net_live or p1 == null or p2 == null:
		return
	if net_mode == Net.HOST:
		_net_state.rpc([state, hud.time_left, round_num, hud.p1_wins, hud.p2_wins, p1.get_net_state(), p2.get_net_state()])
	elif net_mode == Net.CLIENT:
		_net_input.rpc_id(1, _client_bits())


# ============================== MENU / KEYS ==============================

func _input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not event.pressed:
		return
	var k: int = event.keycode
	if state == GState.JOIN_TYPE:
		_type_address(event)
		return
	if event.echo:
		return
	match state:
		GState.MENU:
			if k == KEY_1 or k == KEY_KP_1:
				_start_match(true)
			elif k == KEY_2 or k == KEY_KP_2:
				_start_match(false)
			elif k == KEY_3 or k == KEY_KP_3:
				_host_game()
			elif k == KEY_4 or k == KEY_KP_4:
				state = GState.JOIN_TYPE
			elif k == KEY_ESCAPE:
				get_tree().quit()
		GState.HOST_WAIT, GState.JOIN_WAIT:
			if k == KEY_ESCAPE:
				_to_menu()
		_:
			if k == KEY_ESCAPE:
				_to_menu()
			elif k == KEY_R and state == GState.MATCH_END:
				if net_mode == Net.OFF:
					_to_menu()
				elif net_mode == Net.HOST:
					_start_match(false)


func _clean_address(text: String) -> String:
	var out := ""
	for ch in text.strip_edges():
		if (ch >= "0" and ch <= "9") or (ch >= "a" and ch <= "z") or (ch >= "A" and ch <= "Z") or ch == "." or ch == "-" or ch == ":":
			out += ch
	return out.substr(0, 100)


func _type_address(event: InputEventKey) -> void:
	var k: int = event.keycode
	if k == KEY_ESCAPE:
		state = GState.MENU
	elif k == KEY_ENTER or k == KEY_KP_ENTER:
		if join_ip != "":
			_join_game(join_ip)
	elif k == KEY_BACKSPACE:
		join_ip = join_ip.substr(0, max(0, join_ip.length() - 1))
	elif k == KEY_V and event.ctrl_pressed:
		join_ip = _clean_address(join_ip + DisplayServer.clipboard_get())
	elif event.unicode > 32:
		join_ip = _clean_address(join_ip + char(event.unicode))


func _menu_message(text: String) -> void:
	menu_msg = text
	menu_msg_t = 6.0


# ============================== ONLINE ==============================

func _local_ips() -> Array:
	var out: Array = []
	for a in IP.get_local_addresses():
		if a.contains(":") or a.begins_with("127.") or a.begins_with("169.254."):
			continue
		out.append(a)
	return out


func _host_game() -> void:
	var peer := ENetMultiplayerPeer.new()
	if peer.create_server(NET_PORT, 1) != OK:
		_menu_message("COULD NOT HOST - PORT " + str(NET_PORT) + " IS ALREADY IN USE")
		return
	multiplayer.multiplayer_peer = peer
	net_mode = Net.HOST
	net_live = false
	state = GState.HOST_WAIT
	host_ips = _local_ips()
	_start_upnp()


func _join_game(address: String) -> void:
	var host := address
	var port := NET_PORT
	var separator := address.rfind(":")
	if separator >= 0:
		var port_text := address.substr(separator + 1)
		if separator == 0 or not port_text.is_valid_int():
			state = GState.MENU
			_menu_message("ENTER A VALID ADDRESS OR ADDRESS:PORT")
			return
		host = address.substr(0, separator)
		port = int(port_text)
		if port < 1 or port > 65535:
			state = GState.MENU
			_menu_message("PORT MUST BE BETWEEN 1 AND 65535")
			return
	var peer := ENetMultiplayerPeer.new()
	if peer.create_client(host, port) != OK:
		state = GState.MENU
		_menu_message("COULD NOT CONNECT - CHECK THE ADDRESS")
		return
	multiplayer.multiplayer_peer = peer
	net_mode = Net.CLIENT
	net_live = false
	state = GState.JOIN_WAIT
	join_timer = 12.0
	var f := FileAccess.open(IP_FILE, FileAccess.WRITE)
	if f != null:
		f.store_line(address)


func _net_stop() -> void:
	if net_mode != Net.OFF:
		var peer := multiplayer.multiplayer_peer
		if peer != null:
			peer.close()
		multiplayer.multiplayer_peer = null
	net_mode = Net.OFF
	net_live = false
	net_peer_id = 0
	if upnp != null and upnp_mapped:
		upnp.delete_port_mapping(NET_PORT, "UDP")
	upnp = null
	upnp_mapped = false
	upnp_status = ""


## Leave the online game and show a message on the menu.
func _net_drop(msg: String) -> void:
	if net_mode == Net.OFF:
		return
	_to_menu()
	_menu_message(msg)


func _on_peer_connected(id: int) -> void:
	if net_mode != Net.HOST or state != GState.HOST_WAIT:
		return
	net_peer_id = id
	net_live = true
	_start_match(false)


func _on_peer_disconnected(id: int) -> void:
	if net_mode == Net.HOST and id == net_peer_id:
		call_deferred("_net_drop", "THE OTHER PLAYER LEFT")


func _on_connection_failed() -> void:
	call_deferred("_net_drop", "COULD NOT CONNECT - CHECK THE ADDRESS")


func _on_server_disconnected() -> void:
	call_deferred("_net_drop", "THE HOST LEFT")


func _hosting() -> bool:
	return net_mode == Net.HOST and net_live


## Client: local keys packed into one number. Quick taps are stretched to a
## few frames so a single lost packet cannot swallow a button press.
func _client_bits() -> int:
	var bits: int = Fighter.read_keys(Fighter.Ctrl.KEYS_ANY).to_bits()
	var taps := [4, 16, 32, 64]  # jump, punch, kick, uppercut
	var fresh: int = bits & ~_prev_bits
	_prev_bits = bits
	for i in 4:
		if fresh & taps[i]:
			_latch[i] = 3
		elif _latch[i] > 0:
			_latch[i] -= 1
			bits |= taps[i]
	return bits


@rpc("any_peer", "call_remote", "unreliable_ordered")
func _net_input(bits: int) -> void:
	if not _hosting() or multiplayer.get_remote_sender_id() != net_peer_id:
		return
	if p2 != null and is_instance_valid(p2):
		p2.net_input.from_bits(bits)


@rpc("authority", "call_remote", "unreliable_ordered")
func _net_state(d: Array) -> void:
	if net_mode != Net.CLIENT or not net_live or p1 == null or d.size() < 7:
		return
	state = d[0]
	hud.time_left = d[1]
	round_num = d[2]
	hud.round_num = d[2]
	hud.p1_wins = d[3]
	hud.p2_wins = d[4]
	p1.apply_net_state(d[5])
	p2.apply_net_state(d[6])


@rpc("authority", "call_remote", "reliable")
func _net_begin() -> void:
	if net_mode != Net.CLIENT:
		return
	net_live = true
	vs_cpu = false
	_make_fighters(false)
	p1.puppet = true
	p2.puppet = true
	_reset_hud()
	state = GState.INTRO


@rpc("authority", "call_remote", "reliable")
func _net_sound(k: String) -> void:
	_play_local(k)


@rpc("authority", "call_remote", "reliable")
func _net_announce(text: String, dur: float) -> void:
	_announce_local(text, dur)


@rpc("authority", "call_remote", "reliable")
func _net_hit(dmg: float, heavy: bool, pos: Vector2, blocked: bool) -> void:
	_hit_fx(dmg, heavy, pos, blocked)


@rpc("authority", "call_remote", "reliable")
func _net_shake(t: float) -> void:
	shake_time = max(shake_time, t)


# UPnP asks the router to open the port so friends outside the house can join.
# It runs on a thread because looking for the router takes a couple of seconds.
func _start_upnp() -> void:
	upnp_status = "CHECKING ROUTER..."
	if upnp_thread != null:
		return
	upnp_thread = Thread.new()
	upnp_thread.start(_upnp_work)


func _upnp_work() -> void:
	var u := UPNP.new()
	var ok := false
	var ip := ""
	if u.discover(2000, 2, "InternetGatewayDevice") == UPNP.UPNP_RESULT_SUCCESS and u.get_device_count() > 0:
		var gw := u.get_gateway()
		if gw != null and gw.is_valid_gateway():
			ok = u.add_port_mapping(NET_PORT, NET_PORT, "Stickman Clash", "UDP", 0) == UPNP.UPNP_RESULT_SUCCESS
			if ok:
				ip = u.query_external_address()
	call_deferred("_upnp_done", u, ok, ip)


func _upnp_done(u: UPNP, ok: bool, ip: String) -> void:
	if upnp_thread != null:
		upnp_thread.wait_to_finish()
		upnp_thread = null
	if net_mode != Net.HOST:
		if ok:
			u.delete_port_mapping(NET_PORT, "UDP")
		return
	upnp = u
	upnp_mapped = ok
	if ok and ip != "":
		upnp_status = "READY - FRIEND JOINS  " + ip
	else:
		upnp_status = "ROUTER DID NOT OPEN THE PORT - FORWARD UDP " + str(NET_PORT) + " YOURSELF"


# ============================== MATCH FLOW ==============================

func _reset_hud() -> void:
	hud.p1_name = p1.fighter_name
	hud.p2_name = p2.fighter_name
	hud.p1_wins = 0
	hud.p2_wins = 0
	hud.disp1 = 100.0
	hud.disp2 = 100.0


func _start_match(against_cpu: bool) -> void:
	Engine.time_scale = 1.0
	slowmo_t = 0.0
	shake_time = 0.0
	position = Vector2.ZERO
	vs_cpu = against_cpu
	_make_fighters(against_cpu)
	if net_mode == Net.HOST:
		p1.control = Fighter.Ctrl.KEYS_ANY
		p2.control = Fighter.Ctrl.REMOTE
		_net_begin.rpc()
	_reset_hud()
	round_num = 1
	_start_round()


func _start_round() -> void:
	state = GState.INTRO
	time_left = ROUND_TIME
	round_winner = null
	hud.time_left = int(ROUND_TIME)
	hud.round_num = round_num
	p1.reset_round(420.0, 1)
	p2.reset_round(860.0, -1)
	var my_p1 := p1
	announce("ROUND " + str(round_num), 0.8)
	play_sound("bell")
	await get_tree().create_timer(1.1).timeout
	if state != GState.INTRO or p1 != my_p1:
		return
	announce("FIGHT!", 0.6)
	play_sound("bell")
	await get_tree().create_timer(0.35).timeout
	if state != GState.INTRO or p1 != my_p1:
		return
	state = GState.FIGHT
	for f in fighters:
		f.can_control = true
		f.ai_enabled = f.is_cpu


func _on_fighter_died(f: Fighter) -> void:
	if state != GState.FIGHT:
		return
	state = GState.ROUND_END
	round_winner = f.target
	round_end_delay = 1.9
	for x in fighters:
		x.can_control = false
		x.ai_enabled = x.is_cpu
	if round_winner != null and round_winner.state != Fighter.State.KO:
		round_winner.state = Fighter.State.VICTORY
		round_winner.attacking = false
	Engine.time_scale = 0.3
	slowmo_t = 1.3
	shake_time = 0.45
	if _hosting():
		_net_shake.rpc(0.45)
	announce("K.O.!", 1.3)


func _time_up() -> void:
	state = GState.ROUND_END
	round_end_delay = 1.4
	for x in fighters:
		x.can_control = false
		x.ai_enabled = x.is_cpu
	if p1.health > p2.health:
		round_winner = p1
	elif p2.health > p1.health:
		round_winner = p2
	else:
		round_winner = null
	if round_winner != null:
		round_winner.state = Fighter.State.VICTORY
		round_winner.attacking = false
	announce("TIME UP", 0.9)
	play_sound("bell")


func _end_round() -> void:
	Engine.time_scale = 1.0
	slowmo_t = 0.0
	if round_winner == null:
		announce("DRAW", 1.0)
	else:
		if round_winner == p1:
			hud.p1_wins += 1
		else:
			hud.p2_wins += 1
		announce(round_winner.fighter_name + " WINS!", 1.0)
		play_sound("bell")
	var my_p1 := p1
	await get_tree().create_timer(2.0).timeout
	if state != GState.AWARD or p1 != my_p1:
		return
	if hud.p1_wins >= WINS_NEEDED or hud.p2_wins >= WINS_NEEDED:
		state = GState.MATCH_END
		var champ: Fighter = p1
		if hud.p2_wins > hud.p1_wins:
			champ = p2
		announce(champ.fighter_name + "\nWINS THE MATCH!", 3.0)
		play_sound("bell")
	else:
		round_num += 1
		_start_round()


func _to_menu() -> void:
	_net_stop()
	state = GState.MENU
	Engine.time_scale = 1.0
	slowmo_t = 0.0
	shake_time = 0.0
	position = Vector2.ZERO
	if ann_tween != null and ann_tween.is_valid():
		ann_tween.kill()
	announce_label.modulate.a = 0.0
	_make_fighters(true, true)


func _make_fighters(against_cpu: bool, preview := false) -> void:
	for f in fighters:
		f.queue_free()
	fighters.clear()
	var x1 := 420.0
	var x2 := 860.0
	if preview:
		x1 = 135.0
		x2 = 1145.0
	p1 = Fighter.new()
	p1.player_id = 1
	p1.control = Fighter.Ctrl.KEYS_P1
	p1.fighter_name = "PLAYER 1"
	p1.color = Color(1.0, 0.42, 0.34)
	p1.position = Vector2(x1, GROUND_Y)
	p2 = Fighter.new()
	p2.player_id = 2
	p2.is_cpu = against_cpu
	p2.control = Fighter.Ctrl.CPU if against_cpu else Fighter.Ctrl.KEYS_P2
	p2.fighter_name = "CPU" if against_cpu else "PLAYER 2"
	p2.color = Color(0.4, 0.62, 1.0)
	p2.position = Vector2(x2, GROUND_Y)
	for f in [p1, p2]:
		f.main = self
		add_child(f)
		f.died.connect(_on_fighter_died)
	p1.target = p2
	p2.target = p1
	p1.facing = 1
	p2.facing = -1
	fighters = [p1, p2]


func announce(text: String, dur := 1.0) -> void:
	_announce_local(text, dur)
	if _hosting():
		_net_announce.rpc(text, dur)


func _announce_local(text: String, dur: float) -> void:
	if ann_tween != null and ann_tween.is_valid():
		ann_tween.kill()
	announce_label.text = text
	announce_label.reset_size()
	var h: float = announce_label.size.y
	announce_label.size = Vector2(1280, h)
	announce_label.position = Vector2(0, 230)
	announce_label.pivot_offset = Vector2(640, h / 2.0)
	announce_label.modulate.a = 0.0
	announce_label.scale = Vector2(1.7, 1.7)
	ann_tween = create_tween()
	ann_tween.tween_property(announce_label, "modulate:a", 1.0, 0.15)
	ann_tween.parallel().tween_property(announce_label, "scale", Vector2.ONE, 0.25).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	ann_tween.tween_interval(dur)
	ann_tween.tween_property(announce_label, "modulate:a", 0.0, 0.3)


# ============================== HIT EFFECTS ==============================

func on_hit(_attacker: Fighter, _victim: Fighter, dmg: float, heavy: bool, pos: Vector2, blocked: bool) -> void:
	_hit_fx(dmg, heavy, pos, blocked)
	if _hosting():
		_net_hit.rpc(dmg, heavy, pos, blocked)
	if blocked:
		return
	for f in fighters:
		if heavy:
			f.freeze_time = 0.09
		else:
			f.freeze_time = 0.06


func _hit_fx(dmg: float, heavy: bool, pos: Vector2, blocked: bool) -> void:
	if blocked:
		_play_local("block")
		shake_time = max(shake_time, 0.08)
		_spawn_spark(pos, false, true)
		return
	_play_local("heavy" if heavy else "hit")
	if heavy:
		shake_time = max(shake_time, 0.25)
	else:
		shake_time = max(shake_time, 0.14)
	_spawn_spark(pos, heavy, false)
	_spawn_damage_number(pos, dmg, heavy)


func _spawn_spark(pos: Vector2, strong: bool, blocked: bool) -> void:
	var s := Spark.new()
	s.position = pos
	s.strong = strong
	s.blocked = blocked
	add_child(s)


func _spawn_damage_number(pos: Vector2, dmg: float, big: bool) -> void:
	var dt := DmgText.new()
	dt.position = pos + Vector2(0, -30)
	dt.text = str(int(dmg))
	dt.big = big
	add_child(dt)


# ============================== SOUND (generated, no files) ==============================

func _make_sounds() -> void:
	_add_sound("hit", _make_sound(150.0, 0.16, 0.9, true))
	_add_sound("heavy", _make_sound(85.0, 0.3, 1.0, true))
	_add_sound("block", _make_sound(760.0, 0.07, 0.45, false))
	_add_sound("whiff", _make_sound(200.0, 0.1, 0.22, true))
	_add_sound("jump", _make_sound(330.0, 0.09, 0.3, false))
	_add_sound("ko", _make_sound(55.0, 0.8, 1.0, true))
	_add_sound("bell", _make_sound(880.0, 0.45, 0.4, false))


func _add_sound(k: String, stream: AudioStreamWAV) -> void:
	var node := AudioStreamPlayer.new()
	node.name = "sfx_" + k
	node.stream = stream
	add_child(node)


func play_sound(k: String) -> void:
	_play_local(k)
	if _hosting():
		_net_sound.rpc(k)


func _play_local(k: String) -> void:
	var node := get_node_or_null(NodePath("sfx_" + k))
	if node is AudioStreamPlayer:
		node.play()


func _make_sound(freq: float, dur: float, vol: float, noise: bool) -> AudioStreamWAV:
	var rate := 22050
	var n := int(rate * dur)
	var data := PackedByteArray()
	data.resize(n * 2)
	for i in n:
		var t: float = float(i) / rate
		var s: float = 0.0
		if noise:
			var env: float = pow(1.0 - t / dur, 2.2)
			s = ((randf() * 2.0 - 1.0) * 0.6 + sin(TAU * freq * t) * 0.5) * env * vol
		else:
			var env2: float = pow(1.0 - t / dur, 1.5)
			s = sin(TAU * freq * t * (1.0 - 0.4 * t / dur)) * env2 * vol
		var v := int(clamp(s, -1.0, 1.0) * 32000.0)
		data[i * 2] = v & 0xFF
		data[i * 2 + 1] = (v >> 8) & 0xFF
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = rate
	wav.data = data
	return wav


# ============================== BACKGROUND ==============================

func _draw() -> void:
	draw_rect(Rect2(0, 0, 1280, 720), Color(0.06, 0.07, 0.11))
	draw_circle(Vector2(210, 140), 78, Color(0.7, 0.75, 0.9, 0.05))
	draw_circle(Vector2(210, 140), 60, Color(0.8, 0.83, 0.95, 0.08))
	draw_circle(Vector2(210, 140), 46, Color(0.88, 0.9, 1.0, 0.13))
	var rng := RandomNumberGenerator.new()
	rng.seed = 1337
	for i in 60:
		var sx: float = rng.randf_range(0, 1280)
		var sy: float = rng.randf_range(0, 380)
		draw_circle(Vector2(sx, sy), rng.randf_range(0.8, 1.8), Color(1, 1, 1, 0.25))
	var heights := [220.0, 150.0, 260.0, 190.0, 240.0, 170.0, 210.0, 160.0, 250.0, 180.0]
	var bx := -30.0
	for h2 in heights:
		draw_rect(Rect2(bx, 612.0 - h2, 140.0, h2), Color(0.085, 0.09, 0.135))
		draw_rect(Rect2(bx + 6.0, 622.0 - h2, 128.0, h2 - 10.0), Color(0.055, 0.06, 0.1))
		bx += 132.0
	draw_rect(Rect2(0, 612, 1280, 108), Color(0.05, 0.055, 0.08))
	draw_line(Vector2(0, 612), Vector2(1280, 612), Color(0.35, 0.4, 0.5), 3)
	for i in range(-1, 17):
		var px: float = i * 80.0
		draw_line(Vector2(px, 612), Vector2(px - 34, 720), Color(0.11, 0.12, 0.18), 2)
	draw_circle(Vector2(640, 666), 3, Color(0.3, 0.35, 0.45))


# ============================== EFFECT NODES ==============================

class Spark extends Node2D:
	var t := 0.0
	var strong := false
	var blocked := false

	func _process(delta: float) -> void:
		t += delta
		if t > 0.22:
			queue_free()
		else:
			queue_redraw()

	func _draw() -> void:
		var a: float = clamp(1.0 - t / 0.22, 0.0, 1.0)
		var n := 6
		if strong:
			n = 8
		var base_col := Color(1, 1, 0.85)
		if strong:
			base_col = Color(1, 0.85, 0.3)
		if blocked:
			base_col = Color(0.5, 0.8, 1.0)
		for i in n:
			var ang: float = TAU * i / n + 0.35
			var r0: float = 5.0 + t * 80.0
			var r1: float = 12.0 + t * 100.0
			if strong:
				r1 = 12.0 + t * 130.0
			draw_line(Vector2.from_angle(ang) * r0, Vector2.from_angle(ang) * r1, Color(base_col.r, base_col.g, base_col.b, a), 3.0)
		if strong:
			draw_circle(Vector2.ZERO, 10.0 + t * 40.0, Color(1, 0.9, 0.5, a * 0.4))


class DmgText extends Node2D:
	var t := 0.0
	var text := "8"
	var big := false

	func _process(delta: float) -> void:
		t += delta
		position.y -= 42.0 * delta
		if t > 0.7:
			queue_free()
		else:
			queue_redraw()

	func _draw() -> void:
		var a: float = clamp(1.0 - (t - 0.35) / 0.35, 0.0, 1.0)
		var c := Color(1, 1, 1, a)
		var fs := 24
		if big:
			c = Color(1, 0.4, 0.35, a)
			fs = 30
		draw_string(ThemeDB.fallback_font, Vector2(-40, 0), text, HORIZONTAL_ALIGNMENT_CENTER, 80, fs, c)
