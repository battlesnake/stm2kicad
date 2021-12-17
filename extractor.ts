#!/usr/bin/env ts-node

import fs from 'fs'
import cheerio from 'cheerio'
import _ from 'lodash'
import yargs from 'yargs'

interface Geometry {
	pin_spacing: number
	pin_length: number
	margin_qfp: number
	width_sip: number
	width_dip: number
	margin_ip: number
}

/* STM*CubeMX type */
enum PinConfigType {
	power = 'Power',
	io = 'I/O',
}

/* Kicad Type */
enum PinElectricalType {
	input = 'I',
	output = 'O',
	bidi = 'B',
	tristate = 'T',
	passive = 'P',
	unspecified = 'U',
	power_in = 'W',
	power_out = 'w',
	open_collector = 'C',
	open_emitter = 'E',
	not_connected = 'N',
}

/* Kicad style */
enum PinStyle {
	line = '',
	not_visible = 'N',
	invert = 'I',
	clock = 'C',
	inverted_clock = 'IC',
	low_in = 'L',
	clock_low = 'CL',
	low_out = 'V',
	falling_edge = 'F',
	non_logic = 'NX',
}

interface Pin {
	position: number
	name: string
	config_type: PinConfigType
	elec_type: PinElectricalType
	mode?: string
	label?: string
	assigned: boolean
	block?: Block
	display_name?: string
}

type Direction = 'L' | 'T' | 'R' | 'D'

interface PinPosition {
	x: number
	y: number
	dir: Direction
}

interface Renderer {
	set_pins(pins: Iterable<Pin>): void
	render_block(out: string[]): void
	render_pins(out: string[]): void
}

class SipRenderer implements Renderer {

	private half_inner_width: number = 0
	private half_inner_height: number = 0
	private half_width: number = 0
	private half_height: number = 0
	private pins: ReadonlyArray<Pin> = []

	constructor (
		private readonly geometry: Geometry,
		private readonly unit: number,
	) {
	}

	private calc_geometry(): void {
		this.half_inner_width = this.geometry.width_sip / 2
		this.half_inner_height = (this.pins.length - 1) * this.geometry.pin_spacing / 2
		this.half_width = this.half_inner_width
		this.half_height = this.half_inner_height + (this.geometry.pin_spacing * this.geometry.margin_ip)
	}

	public set_pins(pins: Iterable<Pin>): void {
		this.pins = _.sortBy([...pins], ['name', 'label'])
		this.calc_geometry()
	}

	private get_position(index: number): PinPosition {
		const pin_x = this.half_width + this.geometry.pin_length
		const pin_y = -this.half_inner_height + this.geometry.pin_spacing * index

		return { x: pin_x, y: pin_y, dir: 'L' }
	}

	public render_block(out: string[]): void {
		out.push(`S -${this.half_width} -${this.half_height} ${this.half_width} ${this.half_height} ${this.unit} 1 10 f`)
	}

	public render_pins(out: string[]): void {
		for (let index = 0; index < this.pins.length; ++index) {
			const position = this.get_position(index)
			const pin = this.pins[index]
			out.push(`X ${pin.display_name} ${pin.position} ${position.x} ${-position.y} ${this.geometry.pin_length} ${position.dir} 50 50 ${this.unit} 1 ${pin.elec_type}`)
		}
	}

}

class DipRenderer implements Renderer {

	private half_inner_width: number = 0
	private half_inner_height: number = 0
	private half_width: number = 0
	private half_height: number = 0
	private pins: ReadonlyArray<Pin> = []

	constructor (
		private readonly geometry: Geometry,
		private readonly unit: number,
	) {
	}

	private calc_geometry(): void {
		this.half_inner_width = this.geometry.width_dip / 2
		this.half_inner_height = (Math.ceil(this.pins.length / 2) - 1) * this.geometry.pin_spacing / 2
		this.half_width = this.half_inner_width
		this.half_height = this.half_inner_height + (this.geometry.pin_spacing * this.geometry.margin_ip)
	}

	public set_pins(pins: Iterable<Pin>): void {
		this.pins = _.sortBy([...pins], ['name', 'label'])
		this.calc_geometry()
	}

	private get_position(index: number): PinPosition {
		const side = Math.floor(index / (this.pins.length / 2))
		const side_index = index % (this.pins.length / 2)
		const pin_x = [-1, +1][side] * (this.half_width + this.geometry.pin_length)
		const pin_y = -this.half_inner_height + this.geometry.pin_spacing * side_index

		return { x: pin_x, y: pin_y, dir: 'RL'[side] as Direction }
	}

	public render_block(out: string[]): void {
		out.push(`S -${this.half_width} -${this.half_height} ${this.half_width} ${this.half_height} ${this.unit} 1 10 f`)
	}

	public render_pins(out: string[]): void {
		for (let index = 0; index < this.pins.length; ++index) {
			const position = this.get_position(index)
			const pin = this.pins[index]
			out.push(`X ${pin.display_name} ${pin.position} ${position.x} ${-position.y} ${this.geometry.pin_length} ${position.dir} 50 50 ${this.unit} 1 ${pin.elec_type}`)
		}
	}

}

enum QfpMode {
	ACCURATE = 1,
	COMPACT = 2,
	CRUSHED = 3,
}

enum QfpSide {
	LEFT = 0,
	BOTTOM = 1,
	RIGHT = 2,
	TOP = 3
}

interface QfpPin extends Pin {
	side: number
	position_on_side: number
}

class QfpRenderer implements Renderer {

	private half_inner_width: number = 0
	private half_inner_height: number = 0
	private half_width: number = 0
	private half_height: number = 0
	private pins: ReadonlyArray<QfpPin> = []

	constructor (
		private readonly geometry: Geometry,
		private readonly unit: number,
		private readonly total_pins: number,
		private readonly mode: QfpMode,
	) {
		if (total_pins % 4) {
			throw new Error('Pin count must be multiple of 4')
		}
	}

	private calc_geometry(): void {
		const max_pin_index_h = this.mode === QfpMode.ACCURATE ? this.total_pins / 4 - 1 : _([QfpSide.TOP, QfpSide.BOTTOM]).map(side => _(this.pins).filter(pin => pin.side === side).map(pin => pin.position_on_side).max() ?? 0).max() ?? 0
		const max_pin_index_v = this.mode === QfpMode.ACCURATE ? this.total_pins / 4 - 1 : _([QfpSide.LEFT, QfpSide.RIGHT]).map(side => _(this.pins).filter(pin => pin.side === side).map(pin => pin.position_on_side).max() ?? 0).max() ?? 0
		this.half_inner_width = max_pin_index_h * this.geometry.pin_spacing / 2
		this.half_inner_height = max_pin_index_v * this.geometry.pin_spacing / 2
		this.half_width = this.half_inner_width + this.geometry.margin_qfp * this.geometry.pin_spacing
		this.half_height = this.half_inner_height + this.geometry.margin_qfp * this.geometry.pin_spacing
	}

	public set_pins(pins: Iterable<Pin>): void {
		this.pins = _([...pins])
			.sortBy(pin => pin.position)
			.groupBy(pin => Math.floor((pin.position - 1) / (this.total_pins / 4)))
			.values()
			.map((side, side_index) =>
				_.zip(this.position_pins_on_side(side), side)
				.map(([position_on_side, pin]) => ({
					side: side_index,
					position_on_side: position_on_side!,
					...pin!
				}))
			)
			.flatten()
			.value()
		this.calc_geometry()
	}

	private position_pins_on_side(pins: Pin[]): number[] {
		switch (this.mode) {
		case QfpMode.ACCURATE:
				return pins.map(pin => (pin.position - 1) % (this.total_pins / 4))
		case QfpMode.COMPACT:
				return pins.length === 0 ? [] :
					pins.reduce<[number[], number]>(
						([xs, next], pin) => [
							[...xs, (xs.length ? xs[xs.length - 1] : 0) + (pin.position === next ? 1 : 2)],
							pin.position + 1],
						[[], pins[0].position])[0]
		case QfpMode.CRUSHED:
				return pins.map((_, index) => index)
		default:
				throw new Error('Invalid QFP layout mode')
		}
	}

	private get_position(pin: QfpPin): PinPosition {
		const half_inner_size = [this.half_inner_width, this.half_inner_height]
		const origin = [[-1, -1], [-1, 1], [1, 1], [1, -1]][pin.side]
		const direction = [[0, 1], [1, 0], [0, -1], [-1, 0]][pin.side]
		const dir_char = 'RULD'[pin.side] as Direction
		const coords = [
			...([0, 1].map(i =>
				half_inner_size[i] * origin[i] +
				pin.position_on_side * direction[i] * this.geometry.pin_spacing +
				(direction[i] ? 0 : origin[i]) * (this.geometry.margin_qfp * this.geometry.pin_spacing + this.geometry.pin_length)
			))
		]
		return { x: coords[0], y: coords[1], dir: dir_char }
	}

	public render_block(out: string[]): void {
		out.push(`S -${this.half_width} -${this.half_height} ${this.half_width} ${this.half_height} ${this.unit} 1 10 f`)
	}

	public render_pins(out: string[]): void {
		for (const pin of this.pins) {
			const position = this.get_position(pin)
			out.push(`X ${pin.display_name} ${pin.position} ${position.x} ${-position.y} ${this.geometry.pin_length} ${position.dir} 50 50 ${this.unit} 1 ${pin.elec_type}`)
		}
	}

}

class Block {

	public constructor(
		private readonly renderer: Renderer
	) {
	}

	private readonly pins: Pin[] = []

	public add(pin: Pin): void {
		pin.block = this
		this.pins.push(pin)
	}

	public render(out: string[]): void {
		const renderer = this.renderer
		renderer.set_pins(this.pins.filter(pin => pin.block === this))
		renderer.render_block(out)
		renderer.render_pins(out)
	}

}

interface Options {
	io_style: QfpMode | 'sip'
	separate_config: boolean
	separate_power: boolean
	separate_unassigned: boolean
	drop_unassigned: boolean
	geometry: Geometry
}

/* Kicad symbol units we emit */
enum Unit {
	IO = 1,
	POWER = 2,
	CONFIG = 3,
	UNASSIGNED = 4,
}

interface CubeFile {
	type: string
	family: string
	package: string
	name: string
	pins: Map<number, Pin>
}


function load_cubefile(cubefile: string, db_path: string): CubeFile {

	const kvp: [string, string][] = fs.readFileSync(cubefile, { encoding: 'utf-8' })
		.split('\n')
		.map(s => s.match(/^([^=]+)=(.*)$/))
		.filter(m => m)
		.map(m => [m![1], m![2]])

	const cubefile_data = new Map(kvp)

	const mcu_name = cubefile_data.get('Mcu.Name')!

	const $ = cheerio.load(fs.readFileSync(`${db_path}/mcu/${mcu_name}.xml`, { encoding: 'utf-8' }), { xmlMode: true })

	const package_name = $('Mcu').attr('Package')!

	const name_to_pin = new Map()
	const pin_map = new Map<number, Pin>()

	for (const pin of $('Mcu > Pin')) {
		const position = Number($(pin).attr('Position')!)
		const name = $(pin).attr('Name')!
		const config_type = $(pin).attr('Type')! as PinConfigType
		const assigned = cubefile_data.has(`${name.replace(/ /g, '\\ ')}.Signal`)
		name_to_pin.set(name, position)
		pin_map.set(position, { position, name, config_type, assigned, elec_type: PinElectricalType.unspecified })
	}

	for (const [name, label] of kvp
		.map(([k, v]) => [k.match(/^(.*)\.Signal$/), v])
		.filter(([k, ]) => k)
		.map(([k, v]) => [k![1], v])) {
		if (name_to_pin.has(name)) {
			const pin = pin_map.get(name_to_pin.get(name))!
			const mode = cubefile_data.get(`${name}.Mode`)
			const gpio_label = cubefile_data.get(`${name}.GPIO_Label`)
			pin.label = (gpio_label || label) as string
			if (mode) {
				pin.mode = mode
			}
		}
	}

	return  {
		family: cubefile_data.get('Mcu.Family')!,
		type: mcu_name,
		package: package_name,
		name: cubefile_data.get('Mcu.UserName')!,
		pins: pin_map
	}

}

type BlockName = 'io_block' | 'power_block' | 'config_block' | 'unassigned_block';

type Blocks = Record<BlockName, Block>

function render_symbol(out: string[], options: Options, blocks: Blocks) {
	const { io_block, power_block, config_block, unassigned_block } = blocks;

	const block_order: Block[] = [];

	for (const block of [io_block, power_block, config_block, unassigned_block]) {
		if (block_order.indexOf(block) === -1) {
			block_order.push(block);
		}
	}

	for (const pin of cubefile.pins.values()) {
		const short_name = pin.name.replace(/\s.*/, '')
		pin.display_name = (pin.label ? `${short_name}/${pin.label}` : pin.name).replace(/\s/g, '_')
		if (options.separate_power && pin.config_type === 'Power') {
			pin.elec_type = PinElectricalType.power_in
			power_block.add(pin)
		} else if (options.separate_config && pin.config_type !== 'I/O') {
			pin.elec_type = PinElectricalType.bidi
			config_block.add(pin)
		} else if (pin.assigned || !options.separate_unassigned && !options.drop_unassigned) {
			pin.elec_type = PinElectricalType.passive
			io_block.add(pin)
		} else if (options.separate_unassigned && !options.drop_unassigned) {
			pin.elec_type = PinElectricalType.unspecified
			unassigned_block.add(pin)
		}
	}

	out.push(`EESchema-LIBRARY Version 2.0 24/1/1997-18:9:6`)
	out.push(`DEF ${cubefile.name} U 0 40 Y Y ${block_order.length} L N`)
	out.push(`F0 "U" 0 100 50 H V C C`)
	out.push(`F1 "${cubefile.name}" 0 -100 50 H V C C`)
	out.push(`$FPLIST`)
	out.push(` ${cubefile.package.replace(/LQFP/, 'LQFP-')}`)
	out.push(`$ENDFPLIST`)
	out.push(`DRAW`)
	for (const block of block_order) {
		block.render(out)
	}
	out.push(`ENDDRAW`)
	out.push(`ENDDEF`)
	out.push('')
}

function create_io_block(options: Options) {
	if (options.io_style === 'sip') {
		return new Block(new SipRenderer(options.geometry, Unit.IO))
	} else {
		return new Block(new QfpRenderer(options.geometry, Unit.IO, cubefile.pins.size, options.io_style as QfpMode))
	}
}



const options: Options = {
	io_style: QfpMode.CRUSHED,
	separate_config: true,
	separate_power: true,
	separate_unassigned: true,
	drop_unassigned: false,
	geometry: {
		pin_spacing: 100,
		pin_length: 200,
		margin_qfp: 8,
		margin_ip: 1,
		width_sip: 800,
		width_dip: 1600,
	}
}

const { input, output, database, style: style_arg } = yargs(process.argv.slice(2)).options({
	input: { type: 'string', alias: 'i', describe: 'STM32CubeMX project file (.ioc)', demand: true },
	output: { type: 'string', alias: 'o', describe: 'Kicad library to produce (.lib)', demand: true },
	database: { type: 'string', alias: 'd', describe: 'Path to STM32Cube<X database', default: '/opt/stm32cubemx/db' },
	style: { type: 'string', alias: 's', describe: 'Style for IO pins', choices: ['accurate', 'compact', 'crushed', 'sip'], default: 'crushed' },
}).argv

const style_map = {
	'accurate': QfpMode.ACCURATE,
	'compact': QfpMode.COMPACT,
	'crushed': QfpMode.CRUSHED,
	'sip': 'sip' as 'sip',
}
const style = style_map[style_arg as keyof typeof style_map]
if (style === void 0) {
	throw new Error('Invalid IO style: ' + style_arg)
}
options.io_style = style

const io_block = create_io_block(options);
const power_block = new Block(new SipRenderer(options.geometry, Unit.POWER))
const config_block = new Block(new SipRenderer(options.geometry, Unit.CONFIG))
const unassigned_block = new Block(new DipRenderer(options.geometry, Unit.UNASSIGNED))

const cubefile = load_cubefile(input, database)

const symbol: string[] = []
render_symbol(symbol, options, { io_block, power_block, config_block, unassigned_block })

fs.writeFileSync(output, symbol.join('\n'), { encoding: 'utf-8' })
